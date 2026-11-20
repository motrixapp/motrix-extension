# Motrix 浏览器接管改造方案

**建议交付顺序：先保护原下载并修复确认时的重复文件，再上线请求前直链询问，最后启用可恢复的 Desktop／Server 事务交接。** Chrome、Edge、Brave 和 Firefox 使用同一套所有权规则，保留各自的浏览器事件适配器。确认由扩展负责，桌面端与远端 Server 共用同一提交语义。

本方案于 2026-11-19 核对。#2521 的报告环境是 Motrix 2.4.1，未给出扩展版本；扩展 #55 补充了 Brave 原生保存框和 Motrix 表单同时出现的情况。已记录的 Chrome 单次链接实验中，`onCreated` 显示已收 0 字节时，源站已收到 1 次 GET；在可取消的普通锚点点击中阻止默认动作，确认前文件 GET 为 0。用户观察到的“浏览器没有下载记录”，不能用来判断网盘是否已经扣掉一次下载机会。[#2521](https://github.com/agalwood/Motrix/issues/2521) · [扩展 #55](https://github.com/motrixapp/motrix-extension/issues/55) · [实验条件、数据和浏览器限制](takeover-redesign-2521.zh-CN.md)

### 本地实施进展

扩展已接入官网保护名单及个人域名，晚接管路径已通过 Chromium 和 Firefox 的真实下载项测试。请求前捕获目前在官网中英文下载页单独试用，默认关闭，使用站点提供的安装包大小执行原有规则。右键和其他网站的下载入口沿用已有行为。MDXP 候选分支已在本地整合 0.9.0 的媒体格式能力，协议客户端仍按现有版本协商，服务端持久账本与引擎激活属于后续阶段。

## 六款竞品实际在哪里接管

开源产品使用本次读取的上游提交；版本号为该提交的扩展包版本。IDM 核对了官方商店分发的 Chrome 扩展与厂商手册；ADM 指 amir1376 的 AB Download Manager，核对了官方浏览器扩展和桌面集成入口。各产品的完整安装链路未逐个实机复现。

| 产品 | 触发点与原请求 | 用户决定在哪里发生 | 对 Motrix 的启示 |
| --- | --- | --- | --- |
| **IDM Integration Module 6.43.1** | Chrome MV3 包在启用相关路径时注册 `onCreated` 和 `onDeterminingFilename`。前者关联请求并可按 ID 暂停；后者使用建议文件名、类型和站点规则，后续有恢复与取消两个分支。还有一条按既定主框架 URL 模式用 DNR 重定向到扩展捕获页的路径。 | 桌面 Download File Info 允许立即开始或稍后下载；可按键单次强制／绕过、右键发送、排除站点。临时链接失效时回到原网页刷新下载地址。 | 分开处理“已知 URL 在请求前决定”和“原项出现后暂停”。公开扩展能证实事件组合，Windows 原生宿主对每个站点何时确认所有权仍未知。[官方模块入口](https://www.internetdownloadmanager.com/register/new_faq/chrome_extension.html) · [交互说明](https://www.internetdownloadmanager.com/support/using_idm/starting.html) · [刷新下载地址](https://www.internetdownloadmanager.com/register/new_faq/sites2_3.html) |
| **AB Download Manager（ADM）· 扩展 1.5.2** | 在响应头阶段筛选导航 GET、状态码、文件类型、大小、排除项及绕过键，命中后发送到桌面。Chrome MV3 另用 `downloads.onCreated` 取消原项；Firefox MV2 可等待集成调用后在响应头回调中放行或取消。 | 用户可右键发送、从选区批量添加；桌面导入可打开添加界面，或根据设置静默添加、静默开始。HTTP 集成响应 OK 代表导入调用返回，未提供用户确认或源站传输成功的凭据。 | 借鉴请求 ID 关联重定向、资料不足时放行。Chrome 路径在等桌面回复前已设置处理标记，创建事件可能提前取消浏览器原项；应用未响应时清除标记仍可能来不及。[扩展接管](https://github.com/amir1376/ab-download-manager-browser-integration/blob/bf6811dd8a3ee2b47b94d70e13c2c7e70be7be05/src/linkgrabber/DownloadLinkInterceptor.ts#L361) · [桌面导入](https://github.com/amir1376/ab-download-manager/blob/f15b691c8606774653a49ee65562146e4102320d/desktop/app/src/main/kotlin/com/abdownloadmanager/desktop/integration/IntegrationHandlerImp.kt#L29) · [HTTP 回执](https://github.com/amir1376/ab-download-manager/blob/f15b691c8606774653a49ee65562146e4102320d/integration/server/src/main/kotlin/com/abdownloadmanager/integration/Endpoints.kt#L61) |
| **FluxDown 0.1.28** | Chrome 利用响应头缓存，优先在 `onDeterminingFilename` 判断，`onCreated` 延迟兜底。主路径尝试取消原项再发给客户端；兜底路径中取消异常也可能继续发送。Firefox 可在满足条件的导航附件响应头阶段取消并异步发送；冷启动缺资料、已知客户端不可达等情况放行。 | 桌面捕获事务区分 pending、accepted、rejected、failed；可配置取消后浏览器重下，连续七天内累计三次拒绝可提示排除此站。官方规则还有蓝奏云从页面接口响应提取直链的专门路径。 | 学习按站点分层和区分“用户拒绝／交付失败”。取消原项后通过新 GET 回退会消耗第二次授权；网盘专用适配需单独验证。[接管顺序](https://github.com/zerx-lab/FluxDown/blob/614e467469dc8958d5286f6e0b64a740111b5c4c/fluxDown/background/intercept.ts) · [事务与回退](https://github.com/zerx-lab/FluxDown/blob/614e467469dc8958d5286f6e0b64a740111b5c4c/fluxDown/background/capture-logic.ts) · [官方规则](https://github.com/zerx-lab/FluxDown/blob/614e467469dc8958d5286f6e0b64a740111b5c4c/fluxDown/rules/official.json) |
| **Ghost Downloader 4.5.8／扩展 2.3.4** | Chrome 在文件名事件接管，缺此 API 时使用 `onCreated`。先查绕过键、来源域、后缀和大小，再尝试取消／擦除，随后路由给桌面。取消异常时仍可走路由。 | 右键“下载”和“另存为”分别传直接创建或草稿意图。桌面回执区分 DRAFTED、CREATED、REJECTED；桌面断开时扩展可放入 session 队列。原项已取消后，路由失败的捕获分支没有恢复原响应。 | 用明确动作区分草稿与建单。进入本机待发送队列不代表后端已接受，不能据此取消唯一有效响应。[扩展入口](https://github.com/XiaoYouChR/Ghost-Downloader-3/blob/213f852e9daaadf67ec0d75666093b602e89a3dd/browser_extension/app/src/background.ts) · [路由失败路径](https://github.com/XiaoYouChR/Ghost-Downloader-3/blob/213f852e9daaadf67ec0d75666093b602e89a3dd/browser_extension/app/src/background/resource-bridge.ts) · [桌面回执](https://github.com/XiaoYouChR/Ghost-Downloader-3/blob/213f852e9daaadf67ec0d75666093b602e89a3dd/app/services/browser_service.py) |
| **Gopeed 扩展 1.1.5** | Chrome 优先文件名事件。过滤后 pause；没有处理器则 resume 原 ID，有处理器则先 cancel 后调用。Firefox 对 200 附件导航另有阻塞响应头监听，按 URL 跳过重复事件。 | 本地 Native Messaging 通过 `silent` 控制确认；远端默认服务器可直接建单，多服务器可在页内选择。远端的“确认”设置也影响通知，和本地确认框语义不完全相同。可能在原项取消后才等用户选服务器，退出选择不会恢复原项。 | 可借鉴端点可见性、单次绕过、无处理器时恢复原 ID。Motrix 应在取消前选定端点，并把每次用户操作与 URL 分离。[过滤、暂停和本地／远端路径](https://github.com/GopeedLab/browser-extension/blob/d29bf1b0a7acfe233c3b13e388bb45939133ea48/background/index.ts) |
| **Rayburst Connect 2.2.1** | Chrome 在文件名事件中另行 pause，约 12 秒释放文件名等待；Firefox 可在响应头等待桌面答复再决定取消，并有创建事件兜底。Chrome 暂停异常或超时时仍有继续交接路径。 | 扩展发送 `ack: 'early'`。桌面可在确认界面接手后就回 accepted，直接添加可回 added；扩展据此清理原项，fallback 或交付失败时尝试恢复。启用内容校验时，桌面引擎可先探测 URL，比较响应类型和大小，必要时尝试最终 URL。 | 最接近 #2521 的暂停体验。Motrix 应进一步区分“表单已显示、任务已接受、源站已返回文件”，且对严格单次 URL 禁止额外探测。[Chrome 适配器](https://github.com/AnInsomniacy/rayburst-connect/blob/33991435b39d98f37a1c67f5179a4a841e9b8992/lib/download/chromium-takeover.ts) · [扩展决策](https://github.com/AnInsomniacy/rayburst-connect/blob/33991435b39d98f37a1c67f5179a4a841e9b8992/lib/download/orchestrator.ts) · [桌面确认与探测](https://github.com/AnInsomniacy/rayburst/blob/e15d07ecf9017fe9c51bf24e965f236e7edb8e76/src-tauri/src/services/downloads/mod.rs) |

IDM 包的商店 ID 为 `ngpampappnmepgilojfohadhhmbhlaek`，本次读取的 CRX SHA-256 为 `1d2297ccbdbbf06e9e2546bb9f9b9985433eb7c02d75f09bbcbc9784ece583f7`。证据来自 manifest 和事件处理分支；“所有点击均在首次 GET 前拦下”无法由这些证据推出。Chrome 对常规 MV3 扩展限制阻塞式 webRequest。DNR 可以提前匹配已知 URL；按响应头匹配时，服务器已经收到请求。[Chrome webRequest](https://developer.chrome.com/docs/extensions/reference/api/webRequest#permissions) · [DNR 规则生效时机](https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest#rule-evaluation)

## Motrix 的接管决策

| 捕获时掌握的事实 | 确认前 | 用户选择及结果 |
| --- | --- | --- |
| 命中官网保护名单、用户站点排除，或属于页面专属下载（如 POST 导出、Blob、页面脚本生成文件） | 页面继续，保持原始响应，不为自动接管弹窗 | 浏览器负责。若已取得独立的新授权，可从另一次显式操作开始。 |
| 明确的右键发送，或允许注入页面上的可信普通下载锚点；能保留原意和来源上下文，规则无需探测即可决定 | 对普通点击同步阻止默认动作，再打开表单。只在能限定为原生链接导航的场景启用；站点自己发起 fetch 等路径交给页面 | 用 Motrix、用浏览器、取消三选一。只有选中的一方发起文件请求。严格单次链接还要求授权可传、目标端点支持经过验证的单次 GET 策略。 |
| Chrome 已创建下载项，且已知该站点具体入口可重放，或者已独立取得新授权 | `onCreated` 取得 ID 后检查资格，暂停并重新查询原项，核实仍在进行中且由扩展暂停。文件名事件只补充元数据，及时 `suggest()`。完成、用户已暂停或信息不足就放行 | 选浏览器时 resume **同一个 ID**；显式取消时 cancel 原项；选 Motrix 时按下节协议交接。不能把 `erase` 当作取消成功。 |
| Firefox 响应头已到，但下载项尚未创建 | 可以在这里判断保护或识别附件。新确认模式允许原响应继续；需要晚接管的可重放来源在 `onCreated` 暂停。避免为了等人长期持有阻塞监听 | 同一套确认和回退语义。直接模式也在原有响应取消／探测之前执行网盘保护。内联 PDF、预览与媒体发现保留各自入口。 |
| 请求已经发出，来源未知、令牌可能一次有效、Cookie／IP 绑定无法满足，或事件无法唯一对应 | 浏览器沿原连接读到结束。禁用自动暂停、取消、HEAD、Range 探测和重提 | 这条默认规则保护未入名单的新网盘。若只是看到扩展名、HTTP 200、Accept-Ranges 或大小相符，仍落在本行。 |

“可重放”须有来源方明确约定、可独立补签的适配器，或项目自行控制并能持续验证的下载端点。第一版可用 Motrix 自有验证源跑通晚接管；未经核实的公共镜像和整个云存储／CDN 域不能一并放开。用户配置中的“由 Motrix 下载”仍表达偏好，在资源满足接管条件时生效。**采用这个默认值，会减少无法分类的普通附件的自动接管率。** 上线前用固定样本逐项公布直链、晚接管、保护放行的覆盖数，不靠放宽单次链接规则提高覆盖率。

**交互。** 保留“直接下载／下载前询问”、站点排除和大小规则。表单显示目标设备或 Server、文件名、该端点的目录，以及“尚未发送文件请求”或“浏览器下载已暂停”。“用浏览器下载”“取消此次下载”各自独立。用户在提交前关闭表单、切换端点或表单无法打开，自动入口恢复浏览器原意；显式右键打开的草稿关闭即结束。进入可能已提交阶段后，关闭窗口仅关闭展示。结果不明时显示原端点和“核对任务”，由后台继续对账。同一窗口多项依次展示；超出容量的新项直接放行，避免无人可见的暂停。

对想强制交给 Motrix 的用户，保留现有右键发送；单次绕过和“此站始终用浏览器”放在最接近本次操作的位置。页面事件只作为意图，不能用 `stopImmediatePropagation` 普遍压制网站脚本。Firefox、Chromium、Safari 上能力不足的入口各自降级；Safari 首版保留当前显式工作流。

## 分仓责任及依赖

| 仓库／基线 | 可独立审核的改动 | 完成条件 |
| --- | --- | --- |
| **motrixapp/motrix-extension** · `55393c8`，锁定 MDXP 0.8.1 | 在网络探测和取消前统一执行网盘保护。输入分别保存来源页、初始 URL、重定向后的 URL、原方法与证据来源；缺失的 referrer 保持未知。复用现有 `decideTakeover` 处理用户偏好，确认、暂停、重试由同一操作管理。改造 `interception/{chromium,firefox,webRequestEarly}`、`DownloadConfirmationService`、`confirmedDownload`、`DownloadSubmissionService`、popup 与语言包。 | 后台休眠、二次点击、两个窗口及同 URL 并发均能区分。提交前不会创建 Motrix 任务；只恢复本次操作确实暂停的 ID。可重放、未知和浏览器专属三类均有真浏览器验收。 |
| **motrix-website** · 本地基线 `c1a695a` | 官方保护名单采用固定 schema 的静态 JSON，建议路径 `public/rules/download-protection/v1.json`。官网 PR 审核条目，CI 测精确域、可选子域、路径段边界、来源与资源角色、共享 CDN 正反例。英／中文手册说明绕过、单次链接和规则更新时间。 | 扩展内置同一数据源的发行快照；周期性带 ETag 拉整表，本地匹配。断网、无效 JSON、未知 schema 保留上次有效版。整表定期更新与用户下载无关；不向官网上传 URL、Cookie 或浏览历史。 |
| **motrixapp/mdxp** · 上游 main `1861aea`，0.9.0 | 复用开放的 **PR #4**。本次查询其头为 `0950100`，与 main 有冲突。先重放到 0.9.0，保留现行 media 能力；复验 `download/handoff.prepare`、`.commit`、`.status`、`.abort` 及 `downloadHandoff` 能力协商。按实际发布版本更新两个消费方锁文件。 | 旧 initialize 和 `download/submit` 继续兼容，缺能力或 `acceptingNew=false` 不开启新事务。在途操作始终绑定原实例和认证主体。PR 已有的 schema 测试可直接作为起点。[协议 PR](https://github.com/motrixapp/mdxp/pull/4) · [候选协议原文](https://github.com/motrixapp/mdxp/blob/0950100c23acc7cee10194c001150e8ae484cdcc/docs/download-handoff.zh-CN.md) |
| **agalwood/Motrix** · Desktop 和 Server 共仓，`6ca7b0d`，锁定 MDXP 0.9.0 | 在共享 `src/core/bridge`、`bridge-receiver` 和 `core/session` 实现能力、交接账本与可恢复的引擎激活。复用现有任务、目录、保存路径、Cookie 和端点权限校验。Desktop 与 Server 分别接入并验收，相互独立地宣告能力。 | prepare 不解析 URL、不访问源站、不排入引擎。commit 原子落账、创建任务、写入待激活意图；进程在任一点崩溃后按稳定任务标识恢复。当前 `download/submit` 的内存去重和 taskId 无法独自提供这项保证。[现有接收端](https://github.com/agalwood/Motrix/blob/6ca7b0deb40f48d9edd70e57e56019e8dc3aaafd/src/core/bridge-receiver/bridge-receiver.ts) |
| **Motrix HTTP 引擎适配层，必要时才涉及 aria2 等引擎仓库** | 首版保护与普通文件接管均可独立发布。若要支持“Motrix 首次请求即消费单次链接”，先在实际适配器验证能关闭预解析、预探测、分片、镜像切换和自动重试，并检查重定向、鉴权及远端出口 IP 的语义。 | 真实引擎对严格测试源只消费一次文件授权，下载字节和 SHA-256 正确。无法保证的端点不宣告这一能力；选项表面上设为单连接不足以通过。引擎改动只在真实测试暴露缺口时开独立 PR。 |

**保护列表与权限。** 官网规则只能要求保留浏览器下载；允许重放、补签、向远端传递凭据的能力随可审查的扩展／后端代码发布。固定动作在本地实现，官网只提供数据。示例条目可写成 `{"matchOn":"source","host":"drive.example","includeSubdomains":false,"pathPrefix":"/share/"}`。来源匹配后将保护附在本次操作上，即使 302 跳到共享 CDN 也继续生效。用户排除与官网保护取并集；规则更新期间可立即收紧未提交操作，已发出的事务只做对账。回滚一个错误条目时发布内容修正、版本更新的新快照。已签名 URL、Referer、Cookie、Authorization 不进入诊断或公共名单。[Chrome 对远程数据的说明](https://developer.chrome.com/docs/extensions/develop/migrate/remote-hosted-code)

## 停止浏览器和启动引擎的顺序

| 端点能力 | 必须按此顺序 | 失败如何处理 |
| --- | --- | --- |
| **已发布的旧协议** | 只对明确可重放来源采用晚接管：核实原项已暂停 → 用户确认 → 用现有操作键 `download/submit` → 返回 taskId → 取消原 ID、核实终态。请求前的显式发送仍沿用原提交流程。 | 明确拒绝则恢复原项；回复丢失保持暂停并提示核对；已接受但取消失败，只处理原项，不再提交或自动删除文件。这一兼容路径仍有短暂双所有者窗口。 |
| **双方开启 handoff v1** | 用户确认后冻结端点、目录和选项 → 持久登记 UUID → prepare → 停止原项并保存可核对的终态 → commit。若在首次请求前捕获，登记“此操作没有原项”后即可 commit。 | 停止失败或结果未知，禁止 commit 并尝试 abort。commit 可能发出后只向原实例 status；committed 绑定既有 taskId，aborted／expired 才可按来源可重放性恢复。原项已取消时只能显式重新下载，UI 不得声称能 resume 原 ID。 |

协议 PR 中 `prepare` 即可返回预留 taskId；UI 必须按返回的 **state** 判断。事务键为持久实例 UUID、认证主体和操作 UUID，另核对规范化载荷摘要。现有扩展的 legacy key 形如时间戳加 UUID，迁移时分别存储 wire 模式及原键。旧草稿缺少下载 ID 或端点证据时不按 URL 补猜。首次向新协议发出变更后不降级发送 legacy submit。仅有 not-found 仍可能有在途请求，须有持久的 abort 终止记录才能阻止迟到的操作。

在扩展持久记录中保存恢复所需的操作号、阶段、端点绑定、浏览器 ID、非敏感指纹。会话恢复可利用现有 session 草稿；整个浏览器重启后由最小化的持久记录先查原项／端点，隐身上下文不得写入普通 profile。临时 URL 与凭据不写入长期扩展账本；服务端为激活所需的短期材料走既有受保护存储和清理策略，无法安全恢复时显式终止未激活事务。Cookie 跨域或发往 NAS 仍需现有授权。持久化失败发生在副作用之前时，释放本次暂停并让浏览器完成。

重连查到 prepared 时，恢复器须检查三项证据：本次用户已确认、原项已经停止或本次确实无原项、当前实例与冻结端点一致。三项齐全且准备记录仍有效，才可对同一键和摘要重发 commit。缺证据则请求 abort，再依浏览器实际状态处理；实例发生轮换时保留“待人工核对”。这样后台既能完成已授权的交接，也不会在用户换了设备后激活旧任务。

## 落地批次、验收和回滚

1. **扩展与官网并行。** 扩展先使用内置保护数据，在确认／直接模式的所有自动入口执行同一判断；官网上线规则 JSON 和维护测试。加 Chrome 真浏览器夹具，先记录 #2521 在旧构建中的失败，再验证新构建。官网未上线时内置快照可独立工作。
2. **扩展独立修 #2521／#55。** 在确认模式先上线按原 ID 暂停、核验、释放、异常恢复和中文／英文状态。无需等待 Desktop 升级。按能力保留直接模式的普通下载流程，但保护名单、不可重放和未知来源规则优先；保护判断不能藏在确认分支里。再启用请求前直链捕获及单次绕过，可单独关闭早期捕获。
3. **协议与主机。** MDXP #4 解决冲突并发布后，Motrix Desktop／Server 接入真实账本、权限和故障恢复。能力初始关闭，模拟器与真实主机运行同一契约用例。引擎激活后任务失败按正常任务错误处理，不自动重新启动浏览器。
4. **扩展协商启用。** 新扩展＋旧后端走 legacy；旧扩展＋新后端仍走原 submit；仅新扩展＋宣告能力的后端走 handoff。先用可控本地端点，再启用显式授权的远端 Server。紧急关闭先拒绝新事务，保留 status／abort 和旧实例身份直至在途事务收敛。将严格单次 URL 的引擎支持作为另一个独立发布项。

| 发布门槛 | 必须观察到的事实 |
| --- | --- |
| #2521 普通慢速附件、Brave／Chrome 保存位置询问开与关 | 确认跨过 12 秒后，原项仍暂停、稳定后字节无增长、无 Motrix 任务。选浏览器恢复同一 ID，选 Motrix 仅一项任务且无浏览器完成文件。分别记录原生保存框、扩展表单的出现顺序；晚接管不承诺隐藏所有原生 UI。 |
| 严格网盘与保护名单漏收 | 首次 GET 200、再次 GET／Range 410，并覆盖断开后不能续传的源。已请求时原连接连续读完，源站文件 GET 1 次，扩展 pause／cancel／探测／submit 均为 0，文件摘要正确。另测来源缺失、302 到共享 CDN、登录页 HTML、POST 导出和内联 PDF。 |
| 点击前捕获 | 慢速直链确认期间源站文件 GET 0；选浏览器或 Motrix 只启动所选下载器，取消为 0。右键直接／确认、页面脚本按钮、修饰键与无注入权限各自验证。 |
| 故障和并发 | 录制同 URL 两个独立操作、重复点击同一按钮、worker 休眠／浏览器重启、端点切换、原项被用户恢复、原项已完成、取消失败、接受后丢回执及 prepare／abort／commit 乱序。按操作核对最多一个任务、明确的原项归属、无跨端点误提交。 |
| 响应头判定与下载项创建竞态（AB DM 对照） | 在桌面导入回复前触发 Chrome 创建事件，再注入拒绝或断线。仅被标记为“候选”时原项不得被取消；提交尚未发出或明确被拒绝则保留或恢复原项；提交可能已发出则按原操作对账。另测两个标签页同时下载相同 URL，避免仅按初始／最终 URL 误配原项。 |
| 真实持久化与引擎 | 在 prepare 后、浏览器停止后、commit 已写库但回复前、激活意图已写但引擎未启动、引擎已启动但本地未记回执等边界分别杀进程恢复。独立记录数据库状态、引擎任务数、源站请求和最终文件摘要。旧客户端／新服务端及反向组合必须通过。 |
| 浏览器与发布 | macOS、Windows 的 Chrome stable／Brave 验证保存框，自动化跑固定 Chromium 与 Firefox 基线及 stable；Edge 覆盖 Chromium 发行差异，Safari 验证显式路径。桌面端和远端 Server 各跑真实建单。名单非法、过期缓存、无网络、服务端停收新事务分别验证。 |

**证据与复核。** 本次在固定源码运行 FluxDown 捕获事务及去重测试 13 项、Rayburst Chromium 接管及协调器测试 24 项、Motrix 扩展现行接管测试 119 项、MDXP #4 候选协议测试 26 项，全部通过。前两组是逻辑／模拟依赖测试；后两组描述现有代码和候选契约。前次 Chrome 真浏览器实验与 Firefox 使用 MDXP 模拟器的 22 个场景见诊断文档。表中的新架构、Windows 原生保存框、真实网盘和真实引擎跨仓故障矩阵均为交付门槛，尚未作为本次实测结果。
