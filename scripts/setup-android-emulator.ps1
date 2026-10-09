<#
.SYNOPSIS
    在 Windows 上安装 Android 模拟器（命令行工具 + 系统镜像 + 虚拟设备）。

.DESCRIPTION
    一键完成：下载命令行工具 → 安装 SDK 组件 → 创建虚拟设备。
    脚本是幂等的，重复运行不会重复下载已存在的组件。

    重要前置条件：模拟器需要 Windows 的硬件虚拟化支持（WHPX）。
    脚本会先检测；未启用时给出确切的启用命令。**启用后必须重启电脑。**

    本脚本只做「在手机系统沙箱里跑起来」这件事，不修改应用代码。

.PARAMETER SdkRoot
    SDK 安装目录。默认 D:\Android\Sdk（选 D 盘是因为系统镜像很大）。

.PARAMETER AvdName
    创建的虚拟设备名称。

.PARAMETER ApiLevel
    Android API 级别。默认 34（Android 14）。

.PARAMETER DeviceProfile
    设备型号配置。默认 pixel_6。

.PARAMETER SkipConfirmation
    跳过交互确认（用于自动化）。

.EXAMPLE
    .\scripts\setup-android-emulator.ps1
    交互式安装，每步都会先确认。

.EXAMPLE
    .\scripts\setup-android-emulator.ps1 -SdkRoot D:\Android\Sdk -SkipConfirmation
    无人值守安装。
#>

[CmdletBinding()]
param(
    [string]$SdkRoot = 'D:\Android\Sdk',
    [string]$AvdName = 'bookkeeping_test',
    [int]$ApiLevel = 34,
    [string]$DeviceProfile = 'pixel_6',
    [switch]$SkipConfirmation
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# 命令行工具版本。Google 会更新，这是当前可用版本。
$CmdlineToolsUrl = 'https://dl.google.com/android/repository/commandlinetools-win-11076708_latest.zip'
$PlatformToolsUrl = 'https://dl.google.com/android/repository/platform-tools-latest-windows.zip'

function Write-Step([string]$Text) {
    Write-Host ''
    Write-Host "=== $Text ===" -ForegroundColor Cyan
}

function Write-Ok([string]$Text) { Write-Host "  [OK] $Text" -ForegroundColor Green }
function Write-Warn2([string]$Text) { Write-Host "  [!] $Text" -ForegroundColor Yellow }
function Write-Err2([string]$Text) { Write-Host "  [X] $Text" -ForegroundColor Red }

function Confirm-Action([string]$Question) {
    if ($SkipConfirmation) { return $true }
    $answer = Read-Host "$Question [y/N]"
    return $answer -match '^(y|yes|是)$'
}

# ────────────────────────────────────────────────
# 第 0 步：检测前置条件
# ────────────────────────────────────────────────
Write-Step '第 0 步：检测前置条件'

# 硬件虚拟化：模拟器必需。这一项不满足的话，后面全部白做。
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
$virtualizationEnabled = $cpu.VirtualizationFirmwareEnabled
$hypervisorPresent = (Get-CimInstance Win32_ComputerSystem).HypervisorPresent

Write-Host "  CPU: $($cpu.Name)"
Write-Host "  固件虚拟化已启用: $virtualizationEnabled"
Write-Host "  Hypervisor 正在运行: $hypervisorPresent"

if (-not $virtualizationEnabled) {
    Write-Err2 'BIOS/UEFI 里的虚拟化（Intel VT-x / AMD-V）未启用。'
    Write-Host '      请重启进入 BIOS 打开该选项后再运行本脚本。' -ForegroundColor Yellow
    exit 1
}

if (-not $hypervisorPresent) {
    Write-Warn2 'Windows 的虚拟机监控程序未运行。模拟器需要它，启用后必须重启电脑。'
    Write-Host ''
    Write-Host '      请以【管理员身份】打开 PowerShell，执行：' -ForegroundColor Yellow
    Write-Host '        dism /Online /Enable-Feature /All /FeatureName:HypervisorPlatform' -ForegroundColor White
    Write-Host '        dism /Online /Enable-Feature /All /FeatureName:Microsoft-Windows-Subsystem-Linux' -ForegroundColor White
    Write-Host '      然后重启电脑，再重新运行本脚本。' -ForegroundColor Yellow
    Write-Host ''
    Write-Host '      说明：本脚本不会替你执行这两条命令，因为它们需要管理员权限并会要求重启，' -ForegroundColor DarkGray
    Write-Host '            在你不在场时重启电脑是不合适的。' -ForegroundColor DarkGray

    if (-not (Confirm-Action '仍要继续安装 SDK 吗？（SDK 可先装好，重启后再创建虚拟设备）')) {
        Write-Host '  已取消。' -ForegroundColor DarkGray
        exit 0
    }
} else {
    Write-Ok '虚拟化环境就绪。'
}

# 磁盘空间：系统镜像约 1.5GB，加上 SDK 共需约 4GB。
$drive = (Split-Path -Qualifier $SdkRoot)
$freeGb = [math]::Round((Get-PSDrive -Name $drive.TrimEnd(':')).Free / 1GB, 1)
Write-Host "  $drive 可用空间: ${freeGb}GB"
if ($freeGb -lt 6) {
    Write-Err2 "可用空间不足 6GB，系统镜像可能装不下。"
    exit 1
}

# ────────────────────────────────────────────────
# 第 1 步：下载命令行工具
# ────────────────────────────────────────────────
Write-Step '第 1 步：下载 Android 命令行工具'

New-Item -ItemType Directory -Force -Path $SdkRoot | Out-Null
$cmdlineZip = Join-Path $env:TEMP 'android-cmdline-tools.zip'

if (Test-Path (Join-Path $SdkRoot 'cmdline-tools\latest\bin\sdkmanager.bat')) {
    Write-Ok '命令行工具已安装，跳过下载。'
} else {
    if (-not (Test-Path $cmdlineZip)) {
        Write-Host '  正在下载命令行工具（约 146MB）…'
        Invoke-WebRequest -Uri $CmdlineToolsUrl -OutFile $cmdlineZip -UseBasicParsing
    } else {
        Write-Host '  使用已下载的压缩包。'
    }

    Write-Host '  正在解压…'
    $extractDir = Join-Path $env:TEMP 'android-cmdline-extract'
    Remove-Item -Recurse -Force $extractDir -ErrorAction SilentlyContinue
    Expand-Archive -Path $cmdlineZip -DestinationPath $extractDir -Force

    # 压缩包内层是 cmdline-tools/，sdkmanager 要求放到 cmdline-tools/latest/。
    $latestDir = Join-Path $SdkRoot 'cmdline-tools\latest'
    New-Item -ItemType Directory -Force -Path (Split-Path $latestDir -Parent) | Out-Null
    Remove-Item -Recurse -Force $latestDir -ErrorAction SilentlyContinue
    Move-Item (Join-Path $extractDir 'cmdline-tools') $latestDir
    Remove-Item -Recurse -Force $extractDir -ErrorAction SilentlyContinue

    Write-Ok "命令行工具已安装到 $latestDir"
}

$sdkManager = Join-Path $SdkRoot 'cmdline-tools\latest\bin\sdkmanager.bat'
$avdManager = Join-Path $SdkRoot 'cmdline-tools\latest\bin\avdmanager.bat'

# ────────────────────────────────────────────────
# 第 2 步：接受许可并安装组件
# ────────────────────────────────────────────────
Write-Step '第 2 步：安装 SDK 组件'
Write-Host '  将安装：platform-tools（adb）、emulator、Android API 的模拟器镜像。'
Write-Host '  系统镜像约 1.5GB，这一步会比较久。'

# sdkmanager 的许可交互需要连续输入 y。
$yes = ("y`n" * 30)
$yes | & $sdkManager --sdk_root=$SdkRoot --licenses 2>&1 | Out-Null

$packages = @(
    'platform-tools',
    'emulator',
    "platforms;android-$ApiLevel",
    "system-images;android-$ApiLevel;google_apis;x86_64"
)

foreach ($package in $packages) {
    Write-Host "  安装 $package …"
    $yes | & $sdkManager --sdk_root=$SdkRoot $package 2>&1 |
        Where-Object { $_ -match 'done|Warning|Error|error' } |
        ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
}

Write-Ok 'SDK 组件安装完成。'

# ────────────────────────────────────────────────
# 第 3 步：创建虚拟设备
# ────────────────────────────────────────────────
Write-Step '第 3 步：创建虚拟设备'

$existing = & $avdManager list avd 2>&1 | Out-String
if ($existing -match "Name:\s+$AvdName") {
    Write-Ok "虚拟设备 $AvdName 已存在，跳过创建。"
} else {
    $imageId = "system-images;android-$ApiLevel;google_apis;x86_64"
    Write-Host "  用镜像 $imageId 创建设备 $AvdName …"
    'no' | & $avdManager create avd --name $AvdName --package $imageId --device $DeviceProfile 2>&1 |
        Where-Object { $_ -match 'Error|error' } |
        ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
    Write-Ok "已创建虚拟设备 $AvdName"
}

# ────────────────────────────────────────────────
# 完成
# ────────────────────────────────────────────────
Write-Step '安装完成'

$emulator = Join-Path $SdkRoot 'emulator\emulator.exe'
$adb = Join-Path $SdkRoot 'platform-tools\adb.exe'

Write-Host '  接下来手动执行：'
Write-Host ''
Write-Host '  1) 启动模拟器：' -ForegroundColor White
Write-Host "     & `"$emulator`" -avd $AvdName" -ForegroundColor DarkGray
Write-Host ''
Write-Host '  2) 启动应用（另一个终端）：' -ForegroundColor White
Write-Host '     pnpm dev' -ForegroundColor DarkGray
Write-Host ''
Write-Host '  3) 在模拟器浏览器里访问宿主机：' -ForegroundColor White
Write-Host '     http://10.0.2.2:5173' -ForegroundColor DarkGray
Write-Host '     （10.0.2.2 是模拟器里指向宿主机的固定地址，不能用 localhost）' -ForegroundColor DarkGray
Write-Host ''
Write-Host '  4) 可选：用 adb 转发端口，这样模拟器里也能用 localhost' -ForegroundColor White
Write-Host "     & `"$adb`" reverse tcp:5173 tcp:5173" -ForegroundColor DarkGray
Write-Host "     & `"$adb`" reverse tcp:8787 tcp:8787" -ForegroundColor DarkGray
Write-Host ''
Write-Host '  安全测试清单见 docs/ANDROID-SANDBOX.md' -ForegroundColor Cyan
