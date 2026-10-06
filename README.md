# EdgeLink · Edge 浏览器代理

这是一个 Manifest V3 Edge 扩展，附带独立的 Windows Mihomo 内核

## 安装与使用

1. 双击 **`EdgeLink-Setup-v0.1.3-win-x64.exe`**。一体安装包内已包含扩展、本机助手、Mihomo 内核和三个 Geo 数据库，无需另外下载内核、安装 Node.js 或运行 Clash Verge。选择安装位置并点击安装，安装器会解压文件并自动注册当前 Windows 用户的本机助手，不需要管理员权限。
2. 在 Edge 地址栏打开 `edge://extensions`，开启「开发人员模式」，点击「加载解压缩的扩展」，选择安装器显示的 **extension** 文件夹。安装器提供打开该文件夹的按钮，方便复制路径。
3. 点击工具栏上的 EdgeLink 图标，打开控制面板。在「订阅」页输入订阅 URL，点击「导入配置」，再点击「使用此配置」。此操作会校验配置、启动内置的独立内核并启用 Edge 代理；默认自动检测实际出口。
4. 在「代理」页选择节点，在「连接」页查看公网 IP、出口国家/地区、城市和活跃连接。「首页」顶部刷新及地区卡片「检测」都会重新检测当前出口，切换节点后无需重新开关代理。

也提供 `EdgeLink-v0.1.3-win-x64.zip` 便携包：完整解压到固定目录后双击 `安装本机助手.cmd`，再从第 2 步加载其中的 extension 文件夹。请勿直接在 ZIP 内运行。

Edge 扩展通过本机消息启动随包内核，因此第一次需要安装本机助手；安装器已完成这一注册过程。安装器本身不会启动内核或修改 Windows 系统代理；Edge 扩展仍需按官方开发者方式手动加载。

本地开发目录先运行 `安装本机助手.cmd`，再加载当前目录中的 extension，无需 npm。安装后移动文件夹，请重新运行安装脚本更新路径。

从旧版更新：先在扩展管理器暂时关闭 EdgeLink，运行新一体安装包，再加载安装器显示的新 extension 目录。扩展 ID 保持不变，同一 Edge 配置文件的订阅沿用。若当前扩展本来就加载自开发目录，则在扩展卡片点击重新加载即可更新界面与刷新逻辑；完整一体包另提供内置内核的安装方式。便携包更新时完整解压并重新运行注册脚本。

0.1.3 修复切换节点后刷新仍显示旧地区的问题：每次实际地区检测前，只释放 ipwho.is / api.ip.sb 的旧 HTTPS 连接，让请求通过当前策略重新建立连接，保留其他网站和下载的连接。首页、连接、测试页的顶部刷新会真正检测出口；已打开的首页和弹窗同步地区变化。清理或检测失败时清空旧地区并显示重试提示，不将旧出口当作新结果。

0.1.2 内置经官方发布摘要验证的 Country.mmdb、GeoIP.dat、GeoSite.dat，避免首次使用 GEOIP/GEOSITE 配置时依赖联网下载，修复配置校验被 15 秒期限中止的问题；也可恢复下载中断的不完整 MMDB、空或截断 DAT 缓存。冷应用先校验新配置，因此旧配置损坏不会阻挡新配置启用。「使用此配置」现在同时启用浏览器代理；连接页新增实际出口地区，切换模式/节点或更新当前订阅后默认重新检测。

0.1.1 的订阅兼容修复继续保留：下载时使用 Clash/Mihomo 客户端身份；临时请求头只用于本插件发往该订阅服务器的下载，完成或失败后清除。

## 能力与范围

| 页面 | 可用功能 |
| --- | --- |
| 首页 | 启用/释放 Edge 代理，规则/全局/直连模式，真实出口与内核状态 |
| 代理 | 读取内核实际节点和策略组，搜索、切换、延迟测试 |
| 订阅 | HTTP(S) URL 导入、粘贴导入、更新、使用配置、删除非活动订阅、流量/到期信息（服务商提供时） |
| 连接 | 实际出口 IP/国家/地区/城市/运营商，当前内核连接、代理链、命中规则、流量、关闭连接 |
| 规则 | 添加 Edge 域名/后缀/关键词分流，查看订阅内核规则 |
| 日志 | 脱敏插件日志、实际内核日志、级别过滤与导出 |
| 测试 | 节点实际 HTTP 延迟、出口 IP/地区/运营商、当前路径信息 |
| 设置 | 启停独立内核、自动出口检测、定时订阅更新、测试目标、脱敏诊断 |

完整 Clash/Mihomo YAML 或 JSON 配置由 Mihomo 校验。常见 URI/逐行或 Base64 订阅支持 HTTP(S)、SOCKS5、Shadowsocks、VMess、VLESS、Trojan、Hysteria2；其他 Mihomo 协议可通过完整 YAML 配置导入。SOCKS4 URI 会明确提示不支持。无法通过内核校验的配置不会替换已有配置。订阅输入及展开配置上限为 4 MiB；原生传输会计入 JSON 消息开销。

远程 proxy-providers 和 rule-providers 的缓存路径会固定在本插件数据目录。订阅内的本地 file provider 路径不会读取你电脑上的任意原文件；需要改成远程集合或内联节点配置。

这是**浏览器代理插件**：只管理当前普通 Edge 配置文件中的代理，不提供 Windows 全机 VPN/TUN。内核固定监听 `127.0.0.1:17890`（代理）和 `127.0.0.1:17990`（控制接口），控制器使用随机密钥。配置中的外部监听、额外入站、DNS 监听和 TUN 会被覆盖或删除。关闭代理会释放本插件的设置，恢复浏览器原有代理设置；若系统原先有其他代理，恢复后的路径仍可能经过它。

「规则」模式下检测请求遵循当前分流规则，因此出口结果代表**检测服务的请求路径**；不同网站可能走不同节点。要查看所选节点的出口，可以切到「全局」模式，再确认 GLOBAL 策略组节点并检测。IP 地区数据库只提供近似出口位置。检测服务为 [ipwho.is](https://ipwho.is/) 和 [ip.sb](https://ip.sb/)；没有测到结果时不会编造位置。

节点延迟通过 Mihomo 对所选测试 URL 发起实际 HTTP 请求，不是 ICMP ping。内核累计流量是当前独立内核的统计。连接页只显示此内核中的连接。

## 停止与卸载

先在「设置」停止内核或禁用 Edge 扩展，再双击 `卸载本机助手.cmd`。卸载脚本只移除本目录注册的助手，保留订阅和数据；不删除其他安装目录的注册。正常断开本机消息连接后内核会退出，意外结束助手时也会清理它启动的内核。

## 数据与排查

订阅链接、节点凭据与配置保存在当前 Edge 的 `storage.local` 及 `native/data/config.json`；这不是加密保险库，请保护电脑账户与安装目录。插件不上传配置，也没有网页注入脚本。导入 URL 会访问订阅服务，地区检测会访问上面的 IP 服务；订阅中的节点和集合服务按配置联网。

首次启动失败通常是本机助手未注册、安装目录被移动、企业策略禁止本机消息，或端口 17890/17990 已占用。优先检查 `native/data/host.log`，或查看「日志」页。浏览器代理被其他扩展控制时，会提示先停用冲突扩展。扩展 ID 由 manifest 公钥固定，可在 `native/extension-id.txt` 查看。

没有真实订阅或有效远程节点时，插件可以安装并测试本机流程，但无法凭空提供 VPN 服务器。请使用你已有的有效订阅。

## 开发与验证

```powershell
npm ci
npm run vendor
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build-native.ps1
npm test
npm run check
npm run package
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build-installer.ps1
```

测试目录包含订阅解析、PAC 分流、出口数据处理和后台启用状态测试。`scripts/test-native-geodata.mjs` 用临时目录及 37890/37990 测试缺失/损坏 Geo 数据、旧配置恢复、失败回滚与退出清理。`scripts/test-subscription-activation.mjs` 使用临时 Edge 配置文件、本机助手名和 27890/27990；私有测试 URL 只从 `EDGELINK_TEST_SUBSCRIPTION_URL` 环境变量读取，报告不保存订阅和节点凭据。它验证真实 URL 导入、使用并启用代理、HTTPS 访问及连接页实际出口显示，退出后删除临时数据。

`node scripts/test-geo-refresh.mjs` 使用临时 Edge 配置、临时宿主和 47890/47990，在真实 Edge / Mihomo 中用两个本地 TLS 夹具验证旧连接复用、选择节点后的刷新、自动检测、首页同步、无关连接保留及代理设置零重写。设置 `EDGELINK_REPRODUCE_OLD_GEO=1` 可只在临时副本移除修复，确定复现旧出口；夹具国家不是远程 VPN 验证结果。

`node scripts/test-installer.mjs --test-registration` 验证安装器离线解压、路径校验、文件摘要与独立测试宿主注册。测试使用临时目录和测试注册项，不改变生产宿主、订阅或系统代理。省略 `--test-registration` 时仅验证离线解包和资源。

`scripts/smoke-edge.mjs` 是早期完整界面与本地测试代理流程；它会使用正常端口，已有用户内核运行时不宜执行。本地测试代理不能证明某个远程 VPN 节点可用。验证结果与图片在 `output`，交付证据见 `VERIFICATION.md`。

## 上游与许可

Mihomo 使用官方 [v1.19.32](https://github.com/MetaCubeX/mihomo/releases/tag/v1.19.32) Windows amd64-v1 构建，适用于 Windows x64，不是 ARM64 原生包。官方下载 ZIP 的 SHA-256 已复算并与 GitHub release asset digest 一致，详细记录见 `native/CORE-SOURCE.json`。

Mihomo 上游源码、许可证和构建说明：[MetaCubeX/mihomo](https://github.com/MetaCubeX/mihomo/tree/v1.19.32)。GPL-3.0 许可证随包提供；完整对应的上游源码归档一并放在 `third-party`。本项目源代码、构建脚本也包含在安装包中。YAML 解析库 js-yaml 使用 MIT 许可证，附在 `extension/vendor`。

内置分流数据库来自官方 [MetaCubeX/meta-rules-dat](https://github.com/MetaCubeX/meta-rules-dat)，它们用于 GEOIP/GEOSITE 规则，并不替代实际出口 IP 地区检测。来源、字节数、官方 asset digest 与本地 SHA-256 见 `native/GEODATA-SOURCE.json`，许可证在 `third-party/meta-rules-dat-LICENSE`。开发时可运行 `node scripts/fetch-geodata.mjs` 下载验证后的数据库；已解压的安装包不需要执行下载。
