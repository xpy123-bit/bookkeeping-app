# 在手机/安卓沙箱里运行与安全测试

本文面向**没有开发经验**的读者，按顺序做即可。三种方式，**推荐从方式一开始**，
它不需要安装任何东西，而现在就能跑。

---

## 方式对比

| 方式 | 需要安装 | 多久能用 | 能验证什么 |
| --- | --- | --- | --- |
| **一、浏览器手机模拟** | 无 | 1 分钟 | 界面布局、触控、离线、PWA 安装 |
| **二、真安卓模拟器** | Android SDK（约 2GB） | 首次约 30 分钟 + 重启电脑 | 真手机系统上的完整表现、HTTPS、PWA 安装 |
| **三、真手机 + 局域网** | 无 | 2 分钟 | 最接近真实使用；但 HTTPS 需额外配置 |

> **建议**：先用方式一确认功能正常，再用方式三在真手机上体验。
> 只有确实需要「干净的安卓系统沙箱」时才走方式二。

---

## 方式一：浏览器手机模拟（推荐先做这个）

### 步骤

1. 启动应用：

   ```bash
   pnpm dev
   ```

2. 在 Chrome 里打开 `http://localhost:5173`

3. 按 **F12** 打开开发者工具

4. 按 **Ctrl + Shift + M**（Mac 是 **Cmd + Shift + M**）切换到设备模拟

5. 在顶部设备下拉里选 **Pixel 5** 或 **iPhone 12**

### 这个模式能验证什么

- 界面在窄屏下是否错位、按钮是否够大（触控目标应 ≥ 44px）
- 底部标签栏在带 Home Indicator 的机型上是否被遮挡
- **离线可用**：在 Network 面板把网络切成 `Offline`，刷新后应用应仍能打开
- **PWA 可安装**：Application → Manifest 面板应无报错
- **Service Worker 行为**：Application → Service Workers，确认 `/api/` 与 `/auth/` 不在缓存里

### 注意

浏览器模拟**不会**模拟真实的触摸滚动惯性、软键盘弹出、以及 iOS 的
PWA 后台回收行为。这些只有真手机才能验证。

---

## 方式二：真安卓模拟器

### 前置条件（关键，不满足会白装）

模拟器需要 Windows 的硬件虚拟化。**这一步需要管理员权限，并且必须重启电脑。**

以**管理员身份**打开 PowerShell，执行：

```powershell
dism /Online /Enable-Feature /All /FeatureName:HypervisorPlatform
```

然后**重启电脑**。

> 本项目的脚本**不会**替你执行这一步，因为它在你不参与的情况下重启电脑是不合适的。

### 安装

重启后，在项目目录运行：

```powershell
# 交互式（每步会先确认）
.\scripts\setup-android-emulator.ps1

# 或无人值守
.\scripts\setup-android-emulator.ps1 -SkipDownload:$false -SkipConfirmation
```

脚本会做四件事：

1. 检测虚拟化与磁盘空间（不足会提前退出，不会装到一半失败）
2. 下载并安装 Android 命令行工具
3. 安装 `platform-tools`（含 adb）、`emulator`、Android 14 系统镜像
4. 创建一个名为 `bookkeeping_test` 的虚拟设备

脚本是**幂等**的，重复运行不会重复下载。

### 启动

```powershell
# 1) 启动模拟器
& "D:\Android\Sdk\emulator\emulator.exe" -avd bookkeeping_test

# 2) 另开一个终端启动应用
pnpm dev
```

### 在模拟器里访问宿主机

**模拟器里的 `localhost` 指的是模拟器自己，不是你的电脑。** 这是最常见的卡点。

两种解法，任选其一：

**解法 A：用 `10.0.2.2`**

在模拟器的浏览器里打开：

```
http://10.0.2.2:5173
```

`10.0.2.2` 是 Android 模拟器里固定指向宿主机的特殊地址。

**解法 B：端口转发（更省事，之后可以用 localhost）**

```powershell
& "D:\Android\Sdk\platform-tools\adb.exe" reverse tcp:5173 tcp:5173
& "D:\Android\Sdk\platform-tools\adb.exe" reverse tcp:8787 tcp:8787
```

之后在模拟器里直接访问 `http://localhost:5173` 即可。

### 在模拟器里安装成 App

1. 用模拟器里的 Chrome 打开上面的地址
2. 右上角菜单 → **添加到主屏幕**
3. 之后就有独立图标，全屏运行，**断网也能用**

---

## 方式三：真手机 + 局域网

```bash
pnpm dev
```

1. 确认手机和电脑连同一个 WiFi
2. 在电脑上执行 `ipconfig`，找到 **IPv4 地址**（形如 `192.168.1.10`）
3. 手机浏览器打开 `http://192.168.1.10:5173`

**如果打不开**：多半是 Windows 防火墙拦了。在「Windows 安全中心 → 防火墙和网络保护 →
允许应用通过防火墙」里放行 Node.js。

> **注意**：Service Worker（离线能力）在非 HTTPS 下**只有 localhost 可用**。
> 用 `192.168.x.x` 访问时离线能力会失效。要完整验证 PWA，请部署到 GitHub Pages（HTTPS），
> 或按方式二的模拟器 + `adb reverse` 走 localhost。

---

## 安全测试清单

### 已自动化的部分

这些断言已经写成测试，`pnpm test` 与 `pnpm test:e2e` 会自动执行，**不需要手工做**：

| 断言 | 测试位置 | 验证内容 |
| --- | --- | --- |
| 账本数据不出设备 | `e2e/security.spec.ts` | 记账 + 导入全过程中，用哨兵值确认没有任何请求携带流水 |
| 账单不上传 | `e2e/security.spec.ts` | 账单文件名与真实商户名不出现在任何请求体里 |
| 发票 XML 本地解析 | `e2e/security.spec.ts` | 销售方名称不上传 |
| 不用 localStorage 存账本 | `e2e/security.spec.ts` | 手工写入 IndexedDB 而非 localStorage |
| 会话 Cookie 不可被脚本读取 | `e2e/security.spec.ts` + `server/auth.test.ts` | `document.cookie` 读不到；服务端设为 `HttpOnly` |
| state 单次使用 | `server/auth.test.ts` | 重放同一 state 返回 400 |
| 伪造 state 被拒 | `server/auth.test.ts` | 随机 state 返回 400 |
| 开放重定向被拦 | `server/auth.test.ts` | 外部 `return_to` 被强制改回站内路径 |
| 密钥不外泄 | `server/auth.test.ts` | 注入哨兵密钥值，断言不出现在任何响应里 |
| 未配置渠道的失败方式 | `server/auth.test.ts` | 返回 501 + 补救说明，而非静默跳转 |
| Service Worker 不缓存认证路由 | 构建产物检查 | `dist/sw.js` 的 `navigateFallbackDenylist` 含 `/^\/api\//` 与 `/^\/auth\//`，预缓存清单不含敏感路径 |

运行方式：

```bash
pnpm test          # 单元 + 集成测试（含全部登录安全断言）
pnpm test:e2e      # 手机模拟下的端到端与隐私断言
```

### 需要在模拟器里手工做的部分

自动化测试覆盖不到真机系统的行为，以下几项请在模拟器里手工验证：

- [ ] **断网仍可记账**：开飞行模式，记账、导入 CSV、看报表都应正常
- [ ] **清除浏览器数据后账本消失**：这是当前设计（数据在本地），确认你接受这一点
- [ ] **PWA 安装后独立运行**：装到主屏后打开，应无浏览器地址栏
- [ ] **登录回跳**：若已配置登录渠道，注意从外部授权页跳回时 Cookie 是否带上
      （用了 `SameSite=Lax`，这正是为了允许回跳）
- [ ] **隐私**：在模拟器里用 `adb logcat` 观察，确认应用没有把流水写进系统日志

### 已知的安全边界（如实说明）

- **应用未配置 CSP**。当前没有内联脚本注入点，但加一层 CSP 会更好。
  这是已知的待改进项。
- **后端未启用 HTTPS**。本地开发是 HTTP，因此会话 Cookie 的 `Secure` 属性在生产
  才会打开（`NODE_ENV=production` 时）。**生产部署必须走 HTTPS。**
- **数据不加密**：IndexedDB 里的账本数据是明文。任何能访问该浏览器配置的人都能读到。
  这是本地优先应用的固有取舍，不是缺陷，但你需要知道。
- **没有数据导出**。清空浏览器数据会丢账本。这是当前最实际的风险，已列为待实现项。

---

## 常见问题

**Q：模拟器启动报 `HAXM` 或虚拟化相关错误**
说明第 0 步的 WHPX 没启用或没重启。重做「前置条件」那一步。

**Q：模拟器里打开 `localhost:5173` 是空白**
`localhost` 在模拟器里指模拟器自己。用 `10.0.2.2:5173`，或先做 `adb reverse`。

**Q：`pnpm dev` 起了但手机上打不开**
Windows 防火墙拦了 Node.js。到防火墙设置里放行。

**Q：手机上离线能力无效**
非 HTTPS 环境下 Service Worker 只在 `localhost` 生效。用 `adb reverse`，或部署到 HTTPS。

**Q：脚本报「可用空间不足」**
系统镜像约 1.5GB，加上 SDK 共需约 4GB。换一个空间足够的磁盘：
`.\scripts\setup-android-emulator.ps1 -SdkRoot E:\Android\Sdk`

**Q：PowerShell 报脚本无法加载，提示执行策略限制**
以管理员身份运行一次：`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`
