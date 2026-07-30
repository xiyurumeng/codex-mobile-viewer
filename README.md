# Codex Mobile Viewer

把本机 Codex 对话转换为经过隐私白名单过滤和端到端加密的只读快照，再通过 Cloudflare Pages 供手机查看。Cloudflare 只接收静态网页、密文、匿名文件名和签名清单。

## 运行环境

- Windows 10/11
- Node.js 22 或更高版本
- Codex Desktop 的本地会话目录：`%USERPROFILE%\.codex\sessions`
- 一个 Cloudflare 账号（只有需要手机联网查看时才需要）

项目不需要 `npm install`，也不加载 CDN、统计脚本、外部字体或第三方 JavaScript。

## 首次使用

1. 双击 `Codex对话-管理菜单.cmd`，选择“首次初始化”。
2. 程序会显示一次随机解锁口令。立即保存到密码管理器，程序不会保存口令，也无法找回。
3. 在管理菜单选择“只生成本地加密快照”，先执行隐私扫描。
4. 在管理菜单选择“执行安全检查”，确认签名和所有文件哈希有效。
5. 确认本地阶段正常后，再配置 Cloudflare。

首次初始化会在 `data` 中创建内容主密钥和 Ed25519 私钥的 DPAPI 密文。它们只能由当前 Windows 用户解开。解锁口令只负责在手机浏览器中解开内容主密钥，因此自动同步不需要保存你的口令。

## 配置 Cloudflare

在 [Cloudflare API Tokens](https://dash.cloudflare.com/profile/api-tokens) 创建自定义 Token：

- 权限：`Account` → `Cloudflare Pages` → `Edit`
- 资源：只选择准备使用的那个 Cloudflare Account
- 不要使用 Global API Key
- 可以设置有效期和固定出口 IP，但 VPN 出口变化时固定 IP 可能导致同步失败

从 Cloudflare Dashboard 账户主页复制 32 位 `Account ID`。已知账户 ID 时，可以直接打开：

```text
https://dash.cloudflare.com/你的账户ID/home
```

将“你的账户ID”替换为实际的 32 位 Account ID；不要把 API Token 填进这个网址。然后：

1. 打开 `Codex对话-管理菜单.cmd`，进入“Cloudflare 与网址设置”。
2. 输入一个尚未占用的 Pages 项目名，例如 `my-codex-mobile`。
3. 输入 Account ID。
4. 输入 Token。输入过程不可见，Token 随即用 Windows DPAPI 加密保存。
5. 双击 `Codex对话-一键同步.cmd`，首次创建 Direct Upload Pages 项目并部署。

成功后终端会显示 `https://项目名.pages.dev`。Direct Upload 项目以后不能直接切换为 Git 集成；本项目不需要 Git 集成。

### 更换网址名称

打开 `Codex对话-管理菜单.cmd` → “Cloudflare 与网址设置” → “更换 pages.dev 项目名”，输入例如 `my-codex-mobile`。Cloudflare Pages 不支持把现有 Direct Upload 项目原地改名，因此程序会先创建并完整部署新项目，成功后才把本地配置切换到新网址。旧项目和旧网址不会自动删除，确认新站正常后可在 Cloudflare Dashboard 手动删除旧项目。

## 日常入口

| 文件 | 用途 |
| --- | --- |
| `Codex对话-一键同步.cmd` | 日常使用：检查变化并部署到手机网页 |
| `Codex对话-管理菜单.cmd` | 初始化、状态、安全检查、网址、自动同步、口令和 Token 管理 |
| `sync-auto.cmd` | Windows 计划任务内部入口，普通用户无需双击 |

安装自动同步会修改 Windows 任务计划程序。默认每天在 `00:00` 和 `11:55` 检查并部署一次。到点没有网络时，Node 程序不会启动；Windows 在网络重新连接事件发生后补执行一次，不使用固定间隔轮询或常驻网络检测进程。同一时段成功或确认没有变化后，网络重连触发只读取状态并立即退出，不会重复部署。电脑醒着但处于锁屏界面时可以正常运行；任务不会主动唤醒睡眠中的电脑。睡眠期间错过时间后，会在你手动唤醒且网络可用时补执行。电脑关机时没有任何程序运行；开机登录并联网后，Windows 再处理错过的时段。任务以低优先级运行，可随时使用 `Codex对话-一键同步.cmd` 手动更新。

自动同步限制集中在 `data\config.json`：

- 每日时段：`00:00`、`11:55`
- 断网处理：不启动程序，网络重连事件到达后补执行一次
- 每个时段最多成功自动部署 1 次
- 每天最多成功自动部署 2 次
- 每月最多成功自动部署 62 次

手动一键同步不受时间间隔限制，但没有待部署内容时不会重复部署。

## 上传白名单

只保留：

- 用户可见消息
- 助手 `commentary`
- 助手 `final_answer`
- 标题、时间和消息数量

默认丢弃：

- 系统与开发者提示
- 推理过程
- 工具调用、终端输出和补丁
- 图片及附件内容
- 原始 Session ID
- 未识别事件类型

可见消息中若出现疑似 OpenAI、Cloudflare、GitHub、AWS Token、JWT、Bearer Token 或私钥，程序会省略整条消息并写入安全占位符，然后继续构建。不会只替换 Key 后保留可能泄密的上下文。日志只记录省略数量和凭据类型，不记录消息正文、命中值或所在对话标题。无法安全省略的结构性禁止字段仍会让整次构建失败。

## 手机端安全

- PBKDF2-HMAC-SHA256：600,000 次
- 每个 40 条消息分片独立使用 AES-256-GCM 和随机 IV
- HMAC 匿名化分片文件名
- Ed25519 清单签名和 SHA-256 文件哈希
- 首次信任公钥指纹和快照序号回退检测
- 不把口令、密钥或明文写入 LocalStorage/IndexedDB
- 页面切入后台立即锁定；前台闲置 5 分钟自动锁定
- Service Worker 只缓存网页外壳和密文
- Markdown 使用 DOM `textContent` 渲染，不执行对话中的 HTML
- 严格 CSP 禁止第三方连接、表单、iframe、摄像头、麦克风和定位

LocalStorage 只保存非敏感的签名公钥指纹、最高快照序号、主题选择、正文字号和一次性操作提示状态；不保存口令、内容密钥或对话明文。

## 手机端读取与操作

- 首次打开一条对话只下载并解密最新 40 条消息；向上滚动或点击“加载更早消息”时才读取前一个密文分片。
- 同一路径的并发下载会合并；用户主动打开对话时会暂停其他后台预取。
- 手机、节流模式和实测慢速连接默认不预取；下载连续 20 秒没有收到数据会停止并允许重新打开重试。
- 下载时显示已读取大小；服务器提供可信长度时同时显示百分比。
- 每次打开对话默认显示标题。轻点标题下方的对话区域可收起或重新显示标题；滚动、选择文字、点击按钮和多指操作不会触发切换。
- 对话正文支持双指缩放，范围为 85%–130%；两指距离变化达到 12% 后才启动，缩放会重新排版并保持阅读进度。左下角百分比按钮可恢复 100%。
- 刷新时会在样式绘制前恢复已保存主题，避免亮色页面短暂闪现后才切到暗色。
- 子智能体侧边任务会按匿名父关系归到原对话下；只有存在侧边任务的对话才显示展开按钮。缺失标题时使用安全处理后的任务路径或昵称恢复名称。
- 普通对话只同步 Codex Desktop 当前侧栏索引中的任务；侧栏已经隐藏但磁盘仍保留的旧会话不会进入快照。明确的侧边任务仍会保留，父对话已隐藏时显示为未归类侧边任务。
- 页面切入后台后会立即清除明文并锁定；再次解锁会回到“选择一条对话”的默认页。

## 发布到 GitHub

GitHub 仓库只发布程序源码，不发布本机密钥、配置、日志或任何加密对话快照。现有 Cloudflare Pages 使用 Direct Upload，发布 GitHub 后不会自动关联仓库，也不会改变当前部署方式。

发布前先决定仓库是公开还是私有。若公开并希望允许他人修改和分发，请先选择并添加许可证，例如 MIT；没有 `LICENSE` 时，默认并不授予他人复制和分发权。

1. 在 GitHub 新建一个完全空的仓库，不勾选自动创建 README、`.gitignore` 或许可证。
2. 只在本项目目录 `codex-mobile-viewer` 内初始化 Git，不要在它的上级目录或整个工作区根目录初始化。
3. 先用 `git add --dry-run .` 检查候选文件，确认没有 `data`、`dist`、`dist.previous`、`dist.staging.*`、`logs`、`.env`、`*.dpapi` 或密钥文件。
4. 确认后再提交源码并推送到刚创建的空仓库。

```cmd
cd /d C:\path\to\codex-mobile-viewer
git init
git branch -M main
git status --short --ignored
git add --dry-run .
git add .
git commit -m "Initial release"
git remote add origin https://github.com/你的用户名/codex-mobile-viewer.git
git push -u origin main
```

如果敏感文件曾经进入提交，仅在下一次提交中删除并不安全，因为旧版本仍在 Git 历史中。应立即停止推送、撤销相关 Token，并在确认处理方式后清理历史或重新创建仓库。

## 无法消除的风险

纯静态网站无法在 Cloudflare 账号被完全控制、网页程序整体被替换时提供绝对防护。签名可以阻止攻击者只修改密文或清单，但若假网页本身被部署，它仍可能诱导输入口令。因此：

- 定期在 `Codex对话-管理菜单.cmd` 中执行“安全检查”
- Cloudflare 出现未知部署时立即停止使用网页，并在官网撤销 Token
- 不在已感染木马、装有不可信输入法或被他人控制的手机/电脑上解锁
- 解锁状态下的截屏、拍照和屏幕读取无法由网页可靠检测
- 首次在手机打开站点时，应确保 Cloudflare 账号和本机都未出现异常

## 数据与恢复

- `data`：DPAPI 密钥、配置和非敏感状态，不会上传
- `dist`：当前可部署的静态网页和密文
- `dist.previous`：至少一份本地回滚快照
- `logs`：不含 Token、口令和消息正文的运行日志

不要删除 `data`，否则自动同步无法解开内容主密钥。即使 Cloudflare Token 被盗，攻击者也不能直接解密既有对话；但他可能替换网页，因此仍应立即撤销 Token。

## 开发验证

```cmd
npm.cmd test
node --check src\cli.mjs
node --check web\app.js
```
