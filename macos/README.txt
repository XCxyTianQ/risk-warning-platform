企业经营风险预警平台 · macOS 源码运行版
========================================

这是什么？
----------
桌面端安装包（.dmg / .zip）在未做 Apple 开发者签名时，首次打开会被 macOS 的
Gatekeeper 拦截。本压缩包提供一个"不依赖 Electron 打包产物"的备选方案：
用你本机已安装的 Python 直接运行同一套后端与前端，浏览器访问。

使用前提
--------
1. macOS 11 或更高版本；
2. 已安装 Python 3.10+（推荐 https://www.python.org/downloads/macos/ 官方安装包）；
3. 网络可访问 PyPI（首次运行需要下载依赖）。

使用步骤
--------
1. 把本文件夹拖到"应用程序"或任意目录（路径里尽量不要有中文以外的特殊字符）；
2. 第一次打开时，右键点击 start.command → "打开" → 在弹窗中再点"打开"
   （macOS 会记住这个选择，之后双击即可）；
   * 如果仍被拦截，在"终端"执行一次：
     xattr -dr com.apple.quarantine /路径/到/本文件夹
3. 首次运行会自动创建 ~/.risk-warning-platform/venv 并安装依赖（约 3~8 分钟）；
4. 完成后浏览器会自动打开 http://127.0.0.1:<随机端口>；
5. 首次使用请在右上角"⚙ 设置"里选择模型提供商并填入 API Key。

常见问题
--------
Q: 提示 "未找到 python3"？
A: 安装官方 Python 安装包后重新运行；或在终端执行 `python3 --version` 确认。

Q: 依赖安装很慢或失败？
A: 换网络重试；也可以先执行
   `python3 -m pip config set global.index-url https://pypi.tuna.tsinghua.edu.cn/simple`
   使用国内镜像后重新运行。

Q: 数据存在哪里？
A: ~/.risk-warning-platform/data/platform.db（SQLite），日志在
   ~/.risk-warning-platform/server.log。

Q: 怎么彻底卸载？
A: 删除本文件夹与 ~/.risk-warning-platform 目录即可。
