# bookkeeping-app — 交接文档

移动优先、本地优先的记账 PWA。核心能力：导入**微信支付**与**支付宝**导出的账单，
自动分类、去重、核对，支持**拍照/发票识别**，并给出月度报表与预算超支提醒。

**本文件面向接手开发的 agent。** 读完后应当能直接开工：命令、不变量、
已核实的平台事实、安全约束、以及未完成项都在下面。

---

## 0. 状态速览

| 项 | 状态 |
| --- | --- |
| 类型检查 | ✅ 零错误（`strict` + `noUncheckedIndexedAccess`） |
| 单元 + 集成测试 | ✅ **120 passed / 8 files** |
| 端到端测试 | ✅ **17 passed**，Chromium 手机模拟（Pixel 5） |
| CSP 合规验证 | ✅ 生产构建在 CSP 下 8 步全过，0 违规 0 页面错误 |
| 生产构建 | ✅ 通过，PWA 产物已生成 |
| 账单导入 | ✅ 微信 + 支付宝，含加密 ZIP |
| 自动分类 | ✅ 规则引擎（离线可用）+ 大模型补充长尾商户（可选，失败自动降级） |
| OCR / 发票识别 | ✅ 图片走 OCR，**数电发票 XML 直接解析（无需 OCR）** |
| 登录层 | ✅ 可插拔 provider，含真实 OAuth2 授权码流程 + 演示登录 |
| 安卓沙箱指南 | ✅ `docs/ANDROID-SANDBOX.md` + 一键安装脚本 |

**没有 `.env` 也能完整跑通记账、导入、OCR（XML 路径）、分类、报表。**
后端只承载 OAuth 与云端 OCR/大模型代理，**挂掉不影响主流程**（已有测试保障）。

---

## 1. 命令

```bash
pnpm install          # 装依赖（.npmrc 已配国内镜像）
pnpm dev              # 前端 + 后端一起跑（vite:5173，api:8787）
pnpm dev:web          # 只跑前端；记账、导入、发票 XML 全部可用
pnpm test             # 单元 + 集成测试（含登录安全断言）
pnpm typecheck        # 类型检查
pnpm build            # 生产构建 → dist/（会注入 CSP）
pnpm preview          # 预览构建产物
pnpm test:e2e         # Playwright 手机模拟端到端 + 隐私断言
pnpm icons            # 重新生成 PWA 图标
```

验证生产构建在 CSP 下可用（**改 CSP 后必须跑**）：

```bash
pnpm build
pnpm exec vite preview --port 4173        # 一个终端
node tests/verify-csp.mjs http://127.0.0.1:4173   # 另一个终端
```

环境要求：**Node ≥ 22.5**（依赖内置 `node:sqlite`）、**pnpm 11**。

### 环境注意事项（已实测）

- `registry.npmjs.org` 在部分网络下不可达。`.npmrc` 固定了 `registry.npmmirror.com`
  与 Playwright 的国内镜像。**CI 里用官方源**（见 workflow）。
- **`git` 和 `pnpm` 不会自动使用 Windows 系统代理**，只有浏览器/`Invoke-WebRequest` 会。
  需要代理时显式指定：`git -c http.proxy=http://127.0.0.1:7890 ...`。
- pnpm 11 起构建脚本白名单在 `pnpm-workspace.yaml` 的 `allowBuilds`，
  **`esbuild` 必须放行**，否则 Vite 起不来。
- **`.ps1` 文件必须带 UTF-8 BOM**。Windows PowerShell 5.1 在没有 BOM 时按系统 ANSI
  （中文环境是 GBK）解码，中文会变成乱码字节并产生破坏语法的杂散引号。
  本机 `pwsh` 实际是 PowerShell 5.1，**没有** `-SkipHttpErrorCheck` 等 PS7 参数。
- vitest 内置的 vite 版本早于 `node:sqlite`，无法解析该内置模块。
  已在 `server/db.ts` 用 `process.getBuiltinModule` 绕开（打包器无法静态解析）。

---

## 2. 必须遵守的不变量

改动时下面每条都是硬约束。违反它们会产生**静默的错数据**，比报错危险得多。

1. **金额一律用整数「分」**（`amountCents`）。绝不用浮点数。
   `0.1 + 0.2 !== 0.3` 会直接导致对账失败。见 `src/domain/money.ts`。
2. **解析一律按字段名，不按行号/列号**。平台会调整噪声行数与列序。
   硬编码偏移量会在某次平台更新后静默解析错数据。见 `src/import/csv.ts`。
3. **行字段数少于表头列数时必须拒绝该行**（`reason: 'fewer-fields'`）。
   中间少一列会让后面整体错位，而「收/支」和「金额」可能恰好落在正确位置，
   错数据就被无声记账。**字段数多于表头是合法的**（支付宝备注为空时行尾多一个逗号）。
4. **中性交易单独建模为 `direction: 'transfer'`，绝不当支出**。
   充值/提现/理财/信用卡还款是账户间搬钱，当支出会让资产恒等式崩掉。
   `signedCents('transfer', n) === 0`。
5. **时间用本地墙上时间字符串 `'YYYY-MM-DD HH:mm:ss'`**，不转 UTC。
6. **编码检测用确定性判据**：严格 UTF-8 解码是否抛错。不要用 `chardet`/`jschardet`
   —— GBK/GB2312/GB18030 统计特征高度相似，误判率高。
7. **去重键优先用平台订单号**（`buildDedupeKey`），IndexedDB 层对 `dedupeKey`
   建唯一索引。用户会反复导入同一个月账单，这是真实习惯。
8. **登录是可选的，永不阻塞应用**。会话查询失败必须静默降级为本地模式。
   后端故障不该让记账不可用（`e2e/security.spec.ts` 有断言）。
9. **账本数据不离开设备**。任何新增功能都不得把流水发往服务器。
   `e2e/security.spec.ts` 用哨兵值断言这一点，改动后必须仍通过。
10. **Service Worker 不得缓存 `/auth/*`**（`vite.config.ts` 的
    `navigateFallbackDenylist`）。被缓存的 OAuth 回调可能重放 code/state。
11. **保存或导入后要跳到该笔流水所属的月份**。账单和 OCR 填入的往往是历史日期，
    停在当前月会让用户看到空列表而以为失败。App 的 `setMonth` 回调就是为此存在。

---

## 3. 已核实的平台事实

以下全部经过**真实账单文件逐字节核对**或**官方文档核实**，不是从二手教程抄的。
改动相关代码前请先读这一节。

### 3.1 账单导出形态

- 微信和支付宝导出的**都是加密 ZIP**，内层才是 CSV。
- **微信解压密码**：通过「微信支付」公众号的「账单文件发送成功通知」下发，
  **每人不同**，常见形态 6 位数字。**不是**从邮箱/手机号推导的（该说法无一手来源）。
- **支付宝解压密码**：**实名认证身份证号后 6 位**，末位 X 需大写。
- **微信近期导出可能是 `.xlsx`**（本应用明确提示并拒绝，需另存为 CSV）。
- ZIP 是传统 ZipCrypto，不是 AES。`@zip.js/zip.js` 可解。

### 3.2 编码（最容易翻车的地方）

| 来源 | 编码 | 验证方式 |
| --- | --- | --- |
| 微信支付账单 | **UTF-8** | `tests/fixtures/wechat-real.csv` 严格 UTF-8 解码成功 |
| 支付宝账单 | **GBK / GB18030** | 同一文件严格 UTF-8 解码**失败** |

Node 与浏览器均原生支持 `new TextDecoder('gb18030')`，**不需要 iconv-lite**。

### 3.3 微信列定义（11 列，顺序固定）

```
交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态,交易单号,商户单号,备注
```

- 噪声行：前 16 行为元信息，**第 17 行是表头，第 18 行起是数据**。
  **代码里绝不硬编码 17** —— 已按字段名定位。
- 分隔线：`----------------------微信支付账单明细列表--------------------`
- `收/支` 取值：`收入` / `支出` / **`/`（字面斜杠 = 中性交易）**。
  `/` 不是空值，只判空会把提现/充值误判为支出。
- 金额形态：`¥28.16`（带货币符号）。
- **`交易单号`/`商户单号` 尾部带一个 `\t`**（平台为阻止 Excel 转科学计数法）。
  分词器已 trim；不 trim 会让去重键带上不可见字符，导致重复导入无法识别。
- **提现要扣服务费**：备注形如 `服务费¥0.10`，需从本金中减去。
- `当前状态` 是**开放字符串集合，不要建枚举**。观测值：`支付成功`、`已存入零钱`、
  `已转账`、`朋友已收钱`、`已收钱`、`提现已到账`、`充值完成`、`已到账`、`充值成功`。
- 中性交易类型用**包含**匹配（真实值带后缀，如 `转入零钱通-来自工商银行(9876)`）：
  `零钱充值`、`零钱提现`、`信用卡还款`、`转入零钱通`、`零钱通转出`、`购买理财通`。
- 顶部统计块：`共43笔记录` / `收入：1笔 0.35元` / `支出：1笔 28.16元` / `中性交易：0笔 0.00元`

### 3.4 支付宝列定义（三种变体）

**变体 A — 新版（2022 至今，App「开具交易流水证明」），12 列：**

```
交易时间,交易分类,交易对方,对方账号,商品说明,收/支,金额,收/付款方式,交易状态,交易订单号,商家订单号,备注
```

**变体 B — 2020–2021：字段名相同但列序不同**（`收/支` 在第 0 列，`交易时间` 在末列）。
因为实现是**按名取值**，A 与 B 天然兼容，无需分别处理。

**变体 C — 旧版 PC 网页导出，16 列**：字段名完全不同
（`交易号`/`商品名称`/`金额（元）`/`交易创建时间`/`交易来源地`/`资金状态`），
且不含付款账户。**已明确拒绝**并提示改用 App 导出。
注意：旧版检测必须放在「不是支付宝账单」抛错**之前**，否则永远到不了。

- 表头字段名**带大量填充空格**（`交易时间            ,交易分类`）→ **必须 trim 后按名匹配**。
- 噪声行数随版本变化（实测表头在第 24 行；参考实现分别用 22 和 26）→ **不要硬编码**。
- `收/支` 取值：`支出` / `收入` / `不计收支` / **空字符串** / `其他`（`其他` 仅见变体 B）。
  **空字符串与 `其他` 都按中性处理，绝不能当支出。**
- 退款行商品说明带 `退款-` 前缀，`交易状态 = 退款成功`。
- 顶部统计块用「**不计收支**」而非微信的「中性交易」：
  `共66笔记录` / `收入：1笔 28.50元` / `支出：63笔 16.54元` / `不计收支：2笔 16.37元`

### 3.5 退款与关闭的配对规则

两家都把退款作为**独立一行**，而原始支出行仍然保留。不配对会让同一笔消费计两次。

- 配对依据：订单号相同（或以订单号前缀相同 + 金额相等兜底）。
- 微信：`direction === 'income' && status.includes('退款')` 找原支出。
- 支付宝：`status === '退款成功'` 找原支出。
- 配对的**两行同时剔除**并记入 `skipped`。
- 支付宝 `交易状态 === '交易关闭'` 的行直接剔除（未产生资金流动）。
- 未配对成功的退款**保留为收入并产生 warning**，不静默丢弃。

### 3.6 数电发票：不需要 OCR

依据国家税务总局公告 2024 年第 11 号，电子税务局提供 **PDF / OFD / XML** 三种原件，
其中 **XML 就是发票原件**，含发票号码、开票日期、购销方、金额、税额等全部要素。
**拿得到 XML 就直接解析，零 OCR、零误差。** 把 XML 再走一遍 OCR 既慢又引入误差。

- OFD 本身是「ZIP + XML」容器（GB/T 33190-2016），解压后取 XML 效果相同。
  当前实现**未支持 OFD 直接解析**，会提示用户自行解压取 XML。
- OCR 只用于纸质票照片、扫描件、支付截图。
- 解析后会做交叉校验 `价税合计 ≈ 不含税金额 + 税额`（允许 1 分舍入差），
  不成立时给 warning 而非直接失败。

### 3.7 OCR 金额候选的取舍

**多个候选时绝不猜，全部返回让用户确认。** 但刻意排除 `税额`/`单价`/`数量`/`找零`/
`余额`/`折扣`/`积分` 等上下文 —— 它们是组成部分而非交易总额，放进候选只会让用户误选。
**金额永远只是建议值，必须经用户确认才入账。**

---

## 4. 目录结构

```
src/
  domain/types.ts          交易类型、ParseResult、BillParseError
  domain/money.ts          金额 ↔ 整数分
  import/encoding.ts       UTF-8 → GB18030 确定性检测
  import/csv.ts            容错 CSV 分词器
  import/wechat.ts         微信解析器
  import/alipay.ts         支付宝解析器（含旧版拒绝）
  import/billFile.ts       文件 / ZIP / 密码 → 解析 → 自检
  categorize/rules.ts      规则引擎 + 内置中文商户词典（离线可用）
  categorize/ai.ts         大模型补充分类（可选，失败静默降级）
  ocr/extract.ts           OCR 文本 → 字段候选（不猜测）
  ocr/invoiceXml.ts        数电发票 XML 解析（无需 OCR）
  ocr/client.ts            图片压缩（含 EXIF 摆正）+ 调用服务端
  auth/session.ts          客户端会话（失败静默降级为本地模式）
  db/db.ts                 Dexie：schema、种子分类、去重、月度汇总
  ui/*.tsx                 界面（明细/记一笔/导入/统计 + OCR 面板 + 账户面板）
  App.tsx                  底部标签栏外壳
server/
  app.ts                   Hono 应用装配（可测试，无需真实端口）
  index.ts                 进程入口，仅监听端口
  db.ts                    node:sqlite：users / identities / sessions / oauth_states
  auth/types.ts            IdentityProvider 接口 + capabilities
  auth/providers/mock.ts   演示渠道（走真实授权码路径，不是绕过）
  auth/providers/alipay.ts 支付宝（RSA2 签名，沙箱端点已纠正）
  auth/providers/wechat.ts 微信（协议完整，资质受限）
  auth/registry.ts         渠道注册表（未启用者从注册表移除）
  routes/auth.ts           授权发起 / 回调 / 会话 / 注销
  routes/ocr.ts            图片 → 文本
  routes/ai.ts             大模型分类（可选）
  ocr/index.ts             百度云 + 本地 Umi-OCR 双路
  auth.test.ts             登录链路与安全属性的集成测试
tests/fixtures/            真实账单夹具（微信 UTF-8 / 支付宝 GBK）
tests/verify-csp.mjs       生产构建的 CSP 合规验证
scripts/make-icons.mjs     手写 PNG 编码器生成 PWA 图标
scripts/setup-android-emulator.ps1   安卓模拟器一键安装
e2e/smoke.spec.ts          基础流程
e2e/features.spec.ts       账户面板 + OCR/发票
e2e/security.spec.ts       隐私与安全断言
docs/ANDROID-SANDBOX.md    手机/安卓沙箱运行与安全测试指南
```

---

## 5. 登录接入：硬约束（已核实）

**先读完这节再动手，否则容易在走不通的方向上花掉几周。**

| 渠道 | 个人主体（无公司、无营业执照） |
| --- | --- |
| **支付宝** | ✅ **可申请、可上线**（官方支持账号类型含「个人账号（含个体工商户）」） |
| **微信** | ❌ **走不通**。网站应用登录要求公章 + ICP 备案域名 + 备案主体与认证主体一致 |

**支付宝的三个关键事实：**

1. **限制在「资料」而非「创建」**：个人可创建应用并拿到稳定的 `user_id` / `open_id`，
   但「获取会员信息」的隐私申请**要求企业认证**，所以**拿不到昵称和头像**，
   需自己让用户填。→ 已按 identity-only provider 设计，
   `NormalizedIdentity` 的 name/avatar 可空，并有测试覆盖「无昵称账号登录」。
2. **沙箱无需商业资质**即可完整联调。
3. **端点地址（网上大量教程是错的）**：

```
生产授权  https://openauth.alipay.com/oauth2/publicAppAuthorize.htm
生产网关  https://openapi.alipay.com/gateway.do
沙箱授权  https://openauth-sandbox.dl.alipaydev.com/oauth2/publicAppAuthorize.htm
沙箱网关  https://openapi-sandbox.dl.alipaydev.com/gateway.do
```

> ⚠️ 广泛流传的 `openauth.alipaydev.com` / `openapi.alipaydev.com` **已失效**（网关 502）。
> **连支付宝官方文档里的一段 Java 示例都仍在用旧地址。** 必须用带 `-sandbox.dl` 段的地址。

**其他必须知道的事实：**

- 支付宝 **H5 授权页只能在支付宝客户端内打开**，手机浏览器会报错。
  纯 Web 场景用桌面端扫码更可靠。已编码为 `capabilities.worksInMobileBrowser: false`。
- 支付宝**正在把用户标识从 `user_id` 迁到 `open_id`**（「未来推出的新产品将只支持 openid」）。
  → DB 里**同时存标识符与其遵循的标准**（`subject_standard`），不要只存 `user_id`。
- 支付宝对 `state` 有限制：**base64 后 ≤100 字符且不能含中文**。
- **微信支付宝都不是标准 OIDC 提供方**，`openid-client` / `oauth4webapi` 接不上。
  微信生态的 Node 库基本已停维护（`wechat-oauth` 最后发布 2018 年）→ 几个 HTTP 调用自己写。
  支付宝用官方 `alipay-sdk`（RSA2 签名），当前实现是手写的 `signParams`。
- 微信的坑：2022 年起异常使用 `snsapi_userinfo` 会进入快照页模式，返回
  **`is_snapshotuser: 1` 的虚拟账号**，后端**必须拒绝**（已实现）。
- 微信身份应存 **`unionid`**（不是 `openid`，后者是「用户 + 单个 AppID」维度）。
- 微信在用户拒绝授权时**完全不跳转**，不会带回 error 参数 —— UI 必须能处理
  「用户走开了、再也没回来」这一情况。

**已落实的安全约束（每条都对应真实攻击面，且都有测试）：**

- `redirect_uri` 由**服务端常量**构造，绝不从 `Host` / `X-Forwarded-Host` 推导
- `state` 服务端**单次消费**，重放返回 400
- `return_to` 被限制为站内相对路径，外部地址被强制改回（开放重定向防护）
- 会话是服务端不透明令牌 + `HttpOnly` Cookie，**不用 JWT 放 localStorage**
- Cookie `SameSite=Lax`（`Strict` 会破坏 OAuth 回跳），生产开 `Secure`
- 渠道令牌**绝不返回客户端、绝不持久化**（换取 → 归一化 → 丢弃）
- `UNIQUE(provider, subject)` 是承重约束，防止重放授权码建出重复账号
- 演示渠道走**真实授权码路径**（不是绕过），且在未显式开启时从注册表移除
- 登录发起有滑动窗口限流

`server/index.ts` 启动时会打印渠道状态。接口：

```bash
curl http://127.0.0.1:8787/api/health          # 含各渠道配置状态
curl http://127.0.0.1:8787/api/auth/providers  # 渠道能力与限制说明
```

启用演示登录以验证完整链路：

```bash
ENABLE_MOCK_LOGIN=true pnpm dev
```

---

## 6. 下一步（按优先级）

1. **数据导出/导入（JSON 备份）**。当前清空浏览器数据会丢账本，
   这是**最实际的风险**，也是用户最容易踩的坑。优先级最高。
2. **多设备同步**。登录层已就绪（服务端有 users/identities/sessions），
   缺的是同步与冲突合并。是独立的大工程。
3. **OFD 发票直接解析**。OFD = ZIP + XML，用已有的 `@zip.js/zip.js` 解压后
   复用 `parseInvoiceXml` 即可，约 20 行。
4. **微信 `.xlsx` 账单支持**。需要引入 SheetJS（`xlsx`）。
   注意微信 XLSX 版表头在第 **19** 行（CSV 版是第 17 行）。
5. **iOS Safari 的端到端覆盖**。`playwright.config.ts` 里保留了
   `mobile-safari` 项目但已注释掉 —— 启用需同时 `playwright install webkit`
   并修改 CI 的安装步骤。iOS 是 PWA 怪癖最多的平台，值得补。

---

## 7. 部署

`.github/workflows/ci.yml`：push 后自动跑 类型检查 → 单元/集成测试 → 构建 →
Playwright e2e → 发布 GitHub Pages。

**一次性设置（无法省略）**：仓库 **Settings → Pages → Source 选 "GitHub Actions"**，
然后重跑一次失败的 workflow。

> 这一步没法自动化：workflow 用的是自动生成的 `GITHUB_TOKEN`，而 GitHub **不允许
> 它创建 Pages 站点** —— 加 `actions/configure-pages` 并设 `enablement: true`
> 会以 `Resource not accessible by integration` 失败（那条路需要 PAT，比点一下更麻烦）。
> 所以这里刻意不引入 `configure-pages`。
>
> 仓库名不必等于 `bookkeeping-app`：构建的 base 路径由
> `${{ github.event.repository.name }}` 自动推导。
>
> ⚠️ GitHub Pages **不允许自定义响应头**，因此 CSP 以 `<meta>` 形式注入。
> 托管在支持响应头的环境（Nginx/CDN）时应改为响应头下发，并可补上
> `frame-ancestors 'none'`（meta 形式下该指令会被浏览器忽略）。

---

## 8. 开源署名

账单解析的**格式知识**参考以下项目（许可已核实）：

- [mayswind/ezbookkeeping](https://github.com/mayswind/ezbookkeeping) — **MIT**。
  列定义、状态机、「字段数少于表头则报错」的处理方式参考其实现。
- [deb-sig/double-entry-generator](https://github.com/deb-sig/double-entry-generator) — **Apache-2.0**。
  规则匹配 DSL 设计与退款配对逻辑参考其实现。
  `tests/fixtures/*.csv` 取自该项目 `example/` 目录。

本项目许可：MIT。
