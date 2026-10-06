# 验证记录

浏览器与订阅验证：2026-10-05；一体安装器与最终包验证：2026-10-06（北京时间）。交付版本：EdgeLink 0.1.3，Windows x64。

## 本次已验证

- **42 项 Node 测试全部通过**：订阅解析 21 项、PAC/地区处理 6 项、后台状态 10 项、订阅下载兼容与隐私 5 项。新增回归覆盖旧检测连接定向清理、无关连接保留、Mihomo 空连接列表 null、清理失败清空旧结果，以及内核停止时的原网络路径检测。
- **真实 Edge / Mihomo 的刷新回归 7 项通过**：本地 TLS 夹具 A 建立旧检测连接后，选择 B 并点击首页顶部刷新，直接显示 B；保留另一条 HTTPS 流；自动检测及已打开的首页同步 A；连接页检测 B；隐藏的首页重新可见时同步 B；全过程代理保持启用且 `chrome.proxy.settings.set/clear` 零调用。测试副本只移除修复时，确定复现「选择 B 后刷新仍显示 A」；这两个出口为明确标注的本地测试夹具。
- **真实用户订阅在 Edge 中已成功使用**：23 个节点导入后，通过「使用此配置」表单操作启动真实 Mihomo v1.19.32、加载订阅并接管 Edge PAC。
- 实际 Microsoft Edge **154.0.4258.53** 中的 HTTPS 网页访问成功。此次验证使用真实远程订阅配置，区别于早期的本地 HTTP 代理夹具。
- 激活后自动取得真实公网 IP 和出口位置：**Germany / Hessen / Frankfurt am Main（德国法兰克福）**，来源 ipwho.is。「连接」页实际渲染国家、地区、城市、公网 IP、运营商、时区和检测路径。
- 「连接」页在 1440px 与 430px 窗口正常显示，窄窗口没有横向溢出；本次真实流程没有页面运行异常。
- 三件内置 Geo 数据的实际字节数与 SHA-256 全部匹配 MetaCubeX 官方 release asset digest。完整来源在 `native/GEODATA-SOURCE.json`；数据库只服务于 GEOIP/GEOSITE 分流规则，出口地区仍通过实际公网请求检测。
- Windows PowerShell **5.1** 实际编译新本机助手成功。PowerShell 脚本采用 UTF-8 BOM，避免旧版 PowerShell 将中文脚本按系统代码页解码而产生解析错误。
- **11 个实际本机助手检查点通过**：缺失数据库自动补齐，830,464 字节损坏 MMDB 与无效旧 JSON 恢复，完整已有 MMDB 保留，无效候选保留正在运行的配置，EOF 清理，冷启动失败按字节回滚；另验证零字节/1 字节与截断 DAT 自动恢复，GEOIP 和 GEOSITE 在不可用下载源下离线校验成功，以及有效已有 DAT 保留。
- **一体安装器 6 个检查点通过**：内嵌 ZIP 与完整包摘要一致、asInvoker 权限、离线解包核验扩展/助手/内核/三件数据库、非空目标保留、独立测试宿主注册与备份兼容、ZIP 路径越界拒绝。测试注册项和临时目录均已清理，解包和注册不启动内核。

## 隔离方式与证据

`scripts/test-subscription-activation.mjs` 创建临时 Edge 配置文件和临时 Native Messaging 宿主名；从当前生产源代码复制，**只更换宿主名、代理端口 27890 和控制端口 27990**。它使用独立的临时内核目录运行真实官方 Mihomo，导入实际私有订阅，然后执行启用、HTTPS 网页访问、自动地区检测及连接页显示检查。成功退出后停止该测试内核并删除临时注册项、浏览器配置和凭据文件。

0.1.3 报告 `output/diagnostics/subscription-activation-report.json` 的 5 个真实流程检查全部通过，`productionConfigUnchanged: true` 表示生产配置文件测试前后的 SHA-256 相同。报告只记录计数和出口国家/地区，不保存订阅 URL、配置正文、节点名称或凭据。

`output/playwright/0.1.3-exit-region.png` 是真实 Edge「连接」页出口卡片截图，只截取地区面板，避免把私有订阅或节点信息留在图片中。

`scripts/test-geo-refresh.mjs` 从生产源复制到临时目录，仅替换宿主、47890/47990 测试端口并在临时浏览器配置接受夹具自签名证书。它用真实内核和浏览器的 HTTPS 连接池执行回归。`output/diagnostics/geo-refresh-old-reproduction.json` 是移除修复后的旧行为复现；`geo-refresh-report.json` 是修复版 7 项结果，两者均确认生产配置未变且无页面异常。`output/playwright/0.1.3-geo-refresh-local-fixture.png` 仅是本地夹具结果，不能当作远程节点出口。

`scripts/test-native-geodata.mjs` 专门使用临时目录及 37890/37990 执行本机助手 framing 验证；生产端口与配置不参与其测试。详细结果见 `output/diagnostics/native-geodata-report.json`。

`scripts/test-installer.mjs --test-registration` 在临时目录运行最终安装器的 `--extract-only` 与独立注册检查；仅允许 `com.edgelink.installtest.*` 测试注册名。它核对安装器内嵌 ZIP 摘要、内核和 Geo 字节摘要、非空目录保护、注册备份格式及恶意 ZIP 路径拒绝。最终安装器报告保存在开发目录的 `output/diagnostics/installer-report.json`；安装器是完整 ZIP 的一体封装，该报告在封装后生成，未再嵌入 ZIP。

## 历史验证与范围

0.1.0 的 14 个完整流程检查仍保存在 `output/playwright/edge-smoke-report.json`，覆盖八个页面、弹窗、策略选择、延迟测量、浏览器规则、停止/断开后清理、Windows Job Object、日志与扩展管理器错误检查。该轮转发使用的是明确标注的本地测试代理，不能当作当前用户远程节点的连接证据。

0.1.1 的订阅下载专项报告在 `output/diagnostics/subscription-import-report.json`：普通浏览器身份收到 HTTP 400，临时 Clash/Mihomo 身份导入成功；同源重定向保持身份，结束后规则清除，普通请求身份恢复。该报告仅验证导入，不验证节点连接；0.1.2 的真实启用/HTTPS/地区检查补上了后续环节。

此次确认了当前配置能够实际访问并检测出口，**没有逐一验证全部 23 个节点**。地区结果代表检测服务在当时规则和策略选择下的出口；切换节点或分流路径后可能改变。商店发布和签名安装未进行，交付采用 Edge 官方开发者加载方式。

## 修复行为

- 内置 Country.mmdb、GeoIP.dat、GeoSite.dat，首次启用常见 GEOIP/GEOSITE 配置不必先联网下载这些数据库；缺少尾部 metadata 的 MMDB、空或截断 DAT 会恢复为完整内置数据，有效已有数据库保留。
- 冷应用先校验候选，再启动它；损坏的旧配置不会阻止新有效配置恢复。校验或冷启动失败时保留原配置。
- 「使用此配置」同时启用 Edge 代理并默认自动检测地区；「连接」页显示实际结果。地区服务暂时不可用时显示可重试错误，不伪造位置、不撤销已成功启用的代理。
- 切换节点、模式或更新活动订阅后按自动检测设置刷新出口。
- 每次地区检测前仅关闭两个检测服务的旧连接，首页顶部刷新重新检测，无需开关代理；网页和下载连接保留。

## 官方依据

- [Edge 本机消息与注册](https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/native-messaging)
- [Chromium 浏览器代理 API](https://developer.chrome.com/docs/extensions/reference/api/proxy)
- [Mihomo 全局配置及 Geo 数据](https://wiki.metacubex.one/config/general/)
- [Mihomo v1.19.32 官方发布](https://github.com/MetaCubeX/mihomo/releases/tag/v1.19.32)
- [MetaCubeX 官方分流数据库](https://github.com/MetaCubeX/meta-rules-dat)

最终 ZIP 校验要求包括原生可执行文件、三个 Geo 数据库和来源摘要，且不得包含 native/data、机器注册信息、私有订阅或 node_modules。

最终 `EdgeLink-Setup-v0.1.3-win-x64.exe` 内嵌完整 ZIP，无需联网下载内核；GUI 提供安装根目录、自动本机助手注册以及 Edge 开发者加载步骤。ZIP 与 EXE 旁分别提供 SHA-256 校验文件。Windows PowerShell 5.1 已实际编译；安装器窗体另以透明离屏方式渲染检查，未执行生产安装。
