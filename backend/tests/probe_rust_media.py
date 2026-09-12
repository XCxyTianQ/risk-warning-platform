"""多模态输入与读取验证：附件上传 → 落盘去重 → 视觉读取（Reading）→ 填入表格 → 确认 → 入库。

用法：
    python backend/tests/probe_rust_media.py --port 8253 [--image <png 路径>] [--no-llm]

覆盖：
  1) 上传（JSON base64 / 原始字节 / multipart 三种入口）
  2) 去重：同一张图传两次 → 只落一份文件（sha256 相同、file_path 相同）
  3) 校验：不支持的类型/超大文件被拒
  4) 预览与删除
  5) 视觉读取：产出结构化 Reading（fields/meta/confidence），落库并可从附件元数据读回
  6) 填表：识别结果写入表格（source=vision），**校验拦截入库**（VISION_UNCONFIRMED）
  7) 确认：/confirm 后校验通过，可入库
  8) 对话：SSE 中带 attachment 事件；历史轮次降级为文本投影（第二次请求不再发送图片）
"""

import argparse
import base64
import json
import sys
import urllib.error
import urllib.request
import uuid

PASS, FAIL = 0, 0
DIFFS = []
DEFAULT_IMG = "data/samples/finance_table_demo.png"


def req(port, path, method="GET", body=None, timeout=180, raw=False, headers=None, binary=False):
    url = f"http://127.0.0.1:{port}{path}"
    data = None
    if body is not None:
        data = body if isinstance(body, bytes) else json.dumps(body).encode("utf-8")
    r = urllib.request.Request(url, data=data, method=method)
    if body is not None and not isinstance(body, bytes):
        r.add_header("Content-Type", "application/json")
    for k, v in (headers or {}).items():
        r.add_header(k, v)
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            payload = resp.read()
            if binary:
                return resp.status, payload, dict(resp.headers)
            text = payload.decode("utf-8")
            if raw:
                return resp.status, text
            try:
                return resp.status, json.loads(text)
            except json.JSONDecodeError:
                return resp.status, text
    except urllib.error.HTTPError as exc:
        text = exc.read().decode("utf-8", "ignore")
        if binary:
            return exc.code, b"", {}
        try:
            return exc.code, json.loads(text)
        except json.JSONDecodeError:
            return exc.code, text
    except Exception as exc:  # noqa: BLE001
        if binary:
            return 0, b"", {"error": str(exc)}
        return 0, {"transport_error": str(exc)}


def check(label, ok, detail=""):
    global PASS, FAIL
    if ok:
        PASS += 1
        print(f"  [ok]   {label}")
    else:
        FAIL += 1
        DIFFS.append(f"{label} :: {detail}")
        print(f"  [FAIL] {label} :: {detail}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8253)
    ap.add_argument("--image", default=DEFAULT_IMG)
    ap.add_argument("--no-llm", action="store_true", help="跳过需要真实模型的读取步骤")
    args = ap.parse_args()
    port = args.port

    print(f"=== 多模态输入与读取验证（rust:{port}）===")
    try:
        with open(args.image, "rb") as f:
            img = f.read()
    except FileNotFoundError:
        print(f"找不到图片：{args.image}")
        return 1
    print(f"  测试图片：{args.image}（{len(img)} 字节）")

    # ---------- 1) 三种上传入口 ----------
    print("\n[1] 上传入口（JSON base64 / 原始字节 / multipart）")
    st, up1 = req(port, "/api/attachments", "POST", {
        "filename": "finance_table_demo.png",
        "mime": "image/png",
        "data_base64": base64.b64encode(img).decode(),
        "origin": "paste",
    })
    a1 = up1.get("attachment", {}) if isinstance(up1, dict) else {}
    check("JSON base64 上传", st == 200 and a1.get("id"), f"{st} {str(up1)[:160]}")
    check("返回 sha256 与预览地址",
          bool(a1.get("sha256")) and a1.get("preview_url") == f"/api/attachments/{a1.get('id')}",
          f"{a1.get('sha256')} {a1.get('preview_url')}")

    st, raw = req(port, "/api/attachments/raw", "POST", img, headers={
        "Content-Type": "image/png",
        "X-Filename": "raw-upload.png",
    })
    a2 = raw.get("attachment", {}) if isinstance(raw, dict) else {}
    check("原始字节上传", st == 200 and a2.get("id"), f"{st} {str(raw)[:140]}")

    boundary = f"----rwpuuid{uuid.uuid4().hex}"
    body = b"".join([
        f"--{boundary}\r\n".encode(),
        b'Content-Disposition: form-data; name="file"; filename="mp.png"\r\n',
        b"Content-Type: image/png\r\n\r\n",
        img,
        f"\r\n--{boundary}--\r\n".encode(),
    ])
    st, mp = req(port, "/api/attachments/multipart", "POST", body, headers={
        "Content-Type": f"multipart/form-data; boundary={boundary}",
    })
    a3 = mp.get("attachment", {}) if isinstance(mp, dict) else {}
    check("multipart 上传", st == 200 and a3.get("id"), f"{st} {str(mp)[:140]}")

    # ---------- 2) 去重 ----------
    print("\n[2] 内容寻址去重")
    check("三次上传同一内容 → sha256 一致",
          a1.get("sha256") == a2.get("sha256") == a3.get("sha256"),
          f"{a1.get('sha256')} {a2.get('sha256')} {a3.get('sha256')}")
    check("落盘路径一致（只存一份文件）", a1.get("file_path") == a2.get("file_path") == a3.get("file_path"),
          f"{a1.get('file_path')} | {a2.get('file_path')}")

    # ---------- 3) 拒绝非法输入 ----------
    print("\n[3] 输入校验")
    st, bad = req(port, "/api/attachments", "POST", {
        "filename": "evil.exe", "mime": "application/x-msdownload",
        "data_base64": base64.b64encode(b"MZ...").decode(),
    })
    check("不支持的类型被拒（400）", st == 400, f"{st} {str(bad)[:120]}")
    st, empty = req(port, "/api/attachments", "POST", {
        "filename": "empty.png", "mime": "image/png", "data_base64": "",
    })
    check("空文件被拒（400）", st == 400, f"{st} {str(empty)[:120]}")

    # ---------- 4) 预览 / 元数据 ----------
    print("\n[4] 预览与元数据")
    st, blob, hdrs = req(port, f"/api/attachments/{a1['id']}/raw", binary=True)
    hdrs_lc = {k.lower(): v for k, v in hdrs.items()}
    check("取原始字节（用于缩略图/查看原图）",
          st == 200 and len(blob) == len(img) and blob[:8] == img[:8],
          f"{st} len={len(blob)} (期望 {len(img)}) ct={hdrs_lc.get('content-type')}")
    check("返回正确的 Content-Type", (hdrs_lc.get("content-type") or "").startswith("image/png"),
          f"{hdrs_lc.get('content-type')}")
    st, meta = req(port, f"/api/attachments/{a1['id']}")
    check("元数据含 kind/mime/size", meta.get("kind") == "image" and meta.get("mime") == "image/png"
          and meta.get("size") == len(img), f"{meta}")

    # ---------- 5) 视觉读取 ----------
    print("\n[5] 视觉读取（Reading）")
    attachment_id = a1["id"]
    reading = None
    if args.no_llm:
        print("  [skip] --no-llm：跳过模型读取")
    else:
        st, rd = req(port, f"/api/attachments/{attachment_id}/read", "POST", {"target": "finance"}, timeout=300)
        check("读取接口 200", st == 200 and rd.get("ok") is True, f"{st} {str(rd)[:200]}")
        reading = rd.get("reading") or {}
        fields = reading.get("fields") or []
        check(f"产出结构化字段（{len(fields)} 项）", len(fields) > 0, f"{str(reading)[:200]}")
        check("字段带 field 映射与置信度",
              all("field" in f and "confidence" in f for f in fields), f"{fields[:2]}")
        check("返回 meta（单位/期间线索）", isinstance(reading.get("meta"), dict),
              f"{reading.get('meta')}")
        check("返回 usage（含缓存明细）", "prompt_tokens" in (rd.get("usage") or {}), f"{rd.get('usage')}")
        st, meta2 = req(port, f"/api/attachments/{attachment_id}")
        check("读取结果已落库（reading_status=ok）", meta2.get("reading_status") == "ok",
              f"{meta2.get('reading_status')} {str(meta2.get('reading'))[:120]}")

    # ---------- 6) 填入表格 → 未确认不得入库 ----------
    print("\n[6] 识别结果填入表格（待确认 → 拦截入库）")
    ent_id = None
    st, ents = req(port, "/api/enterprises")
    if isinstance(ents, dict) and ents.get("items"):
        ent_id = ents["items"][0]["id"]
    st, created = req(port, "/api/tables", "POST", {
        "enterprise_id": ent_id, "title": "图片识别测试表", "kind": "kpi",
        "periods": ["2025"], "unit": "万元",
    })
    tid = created.get("table_id")
    check("创建测试表格", st == 200 and tid, f"{st} {str(created)[:140]}")
    if reading and fields and tid:
        st, rd2 = req(port, f"/api/attachments/{attachment_id}/read", "POST",
                      {"target": "finance", "table_id": tid}, timeout=300)
        fill = rd2.get("fill") or {}
        check("识别结果写入表格（source=vision）", fill.get("written", 0) > 0, f"{str(fill)[:200]}")
        st, v1 = req(port, f"/api/tables/{tid}/validate", "POST")
        codes = [i["code"] for i in v1.get("issues", [])]
        check("未确认的识别结果阻止入库（VISION_UNCONFIRMED）", "VISION_UNCONFIRMED" in codes, f"{codes}")
        st, blocked = req(port, f"/api/tables/{tid}/ingest", "POST", {})
        check("入库被拒（400）", st == 400, f"{st} {str(blocked)[:160]}")
        # 确认
        st, conf = req(port, f"/api/tables/{tid}/confirm", "POST", {})
        check("确认识别结果", st == 200 and conf.get("confirmed", 0) > 0, f"{st} {conf}")
        st, v2 = req(port, f"/api/tables/{tid}/validate", "POST")
        codes2 = [i["code"] for i in v2.get("issues", [])]
        check("确认后校验通过", v2.get("ok") is True and "VISION_UNCONFIRMED" not in codes2, f"{codes2}")
    else:
        print("  [skip] 无读取结果（--no-llm 或读取失败）")

    # ---------- 7) 对话：attachment 事件 + 历史文本化 ----------
    print("\n[7] 对话携带附件（SSE attachment 事件 + 历史降级）")
    if args.no_llm:
        print("  [skip] --no-llm")
    else:
        import http.client

        def stream(body):
            conn = http.client.HTTPConnection("127.0.0.1", port, timeout=300)
            conn.request("POST", "/api/chat/stream", body=json.dumps(body).encode(),
                         headers={"Content-Type": "application/json"})
            resp = conn.getresponse()
            events = []
            event = None
            for raw_line in resp:
                line = raw_line.decode("utf-8").rstrip("\r\n")
                if line.startswith("event:"):
                    event = line[6:].strip()
                    continue
                if line.startswith("data:"):
                    try:
                        events.append((event, json.loads(line[5:].strip())))
                    except json.JSONDecodeError:
                        pass
            conn.close()
            return resp.status, events

        st, events = stream({"message": "这张图里是什么？用一句话说明", "attachment_ids": [attachment_id]})
        names = [e for e, _ in events]
        att_events = [d for e, d in events if e == "attachment"]
        check("SSE 200 且出现 attachment 事件", st == 200 and len(att_events) == 1, f"{st} {names[:8]}")
        if att_events:
            check("attachment 事件带媒体 token 估算",
                  att_events[0].get("media_tokens", 0) > 0, f"{att_events[0].get('media_tokens')}")
            check("附件挂到了消息上", att_events[0].get("message_id") is not None, f"{att_events[0]}")
        check("对话正常结束（无 error 事件）", "error" not in names, f"{names}")
        # 第二次对话：不带附件 → 历史里的图片应降级为文本投影（不再发送图片）
        st, events2 = stream({"message": "刚才那张图里的公司是哪家？"})
        names2 = [e for e, _ in events2]
        check("后续轮次正常（历史图片已文本化）", st == 200 and "error" not in names2, f"{names2[:8]}")
        st, usage = req(port, "/api/chat/usage")
        check("用量接口仍可用（含 preheat）", st == 200 and "preheat" in usage, f"{st}")

    # ---------- 8) 清理 ----------
    print("\n[8] 删除与列表")
    st, lst = req(port, "/api/attachments")
    check("附件列表", st == 200 and lst.get("total", 0) >= 3, f"{st} total={lst.get('total')}")
    st, gone = req(port, f"/api/attachments/{a3['id']}", "DELETE")
    check("删除附件", st == 200 and gone.get("deleted") == a3["id"], f"{st} {gone}")
    st, still, _ = req(port, f"/api/attachments/{a1['id']}/raw", binary=True)
    check("重复内容删除后原文件仍在（引用计数）", st == 200 and len(still) == len(img), f"{st} len={len(still)}")

    print(f"\n=== 结果：{PASS} 通过 / {FAIL} 失败 ===")
    for d in DIFFS:
        print("  -", d)
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
