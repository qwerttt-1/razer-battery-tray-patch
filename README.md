# 雷蛇原托盘电量圆环补丁

让 Razer Synapse 原来的托盘图标显示鼠标电量：绿色圆环随电量变化，悬停显示设备名称和实际百分比，原来的点击和右键菜单继续保留。

**当前仅支持 Windows 64 位、默认位置安装的 Razer Synapse 4.0.896，且应用资源与已核对的原版一致。**

[下载 Windows 单文件程序](https://github.com/qwerttt-1/razer-battery-tray-patch/releases/latest)

## 使用

1. 下载 Releases 中的 `RazerTrayPatchInstaller.exe`。
2. 双击运行，选择“应用补丁”，按 Windows 提示授权。
3. 程序备份原文件、正常退出 Synapse、应用补丁并重新启动 Synapse。
4. 需要恢复时，在同一程序中选择“恢复原版”。

已经安装同一版本时会提示无需重复应用。只需复制这个 EXE，不需要额外安装 Python、Node.js 或开发工具。操作完成后可以关闭程序，不增加启动项、服务或额外常驻进程。

## 图标与分档

内置 21 档、40 像素圆环设计、原始中心图案的 ICO。每档包含 16、20、24、32、40、48、64、72、96、128、256 像素图像，适配系统图标缩放。

| 实际电量 | 显示规则 | 示例 |
| --- | --- | --- |
| 低于 49% | 向下取 5% 档位 | 48% → 45% |
| 49%–51%，含两端 | 固定为 50% 档 | 49%、50%、51% → 50% |
| 高于 51% | 向上取 5% 档位 | 52% → 55%，79% → 80% |

悬停保留实际电量和充电状态。多个电池设备同时存在时，圆环使用最低电量，悬停列出各设备。没有有效设备电量时恢复普通图标。

## 实现与备份

补丁修改安装目录中的 `resources/app.asar`，在原托盘创建后加载更新模块，并修复菜单重建把悬停文字重置成“Razer”的问题。电量来自 Synapse 已有的内部设备状态事件，没有额外设备查询或轮询计时器。

原版资源备份保存在安装目录的：

```text
resources/razer-battery-backup/original-app.asar
```

程序会核对原文件、已安装补丁和备份的哈希；资源不匹配时停止操作。原版资源的 SHA-256 为：

```text
e7a524aca1771251ca4f851441a97cac1c33929891b291ed34deb7adfc1831ec
```

工具内置文件及日志位于 `%LOCALAPPDATA%\RazerTrayBatteryPatch\installer-1.4`。工具正常运行不依赖 GitHub 或本仓库的在线文件。

Synapse 更新可能覆盖补丁；本版本不会强行修改其他版本，也不要把旧版 `app.asar` 复制到新版安装目录。

## 从源码构建

需要 Windows 64 位、Visual Studio / Build Tools 的 C++ 工作负载、Windows SDK 和 CMake。可使用 Visual Studio 自带的 CMake。

在项目根目录运行：

```bat
build.cmd
```

输出为 `build\RazerTrayPatchInstaller.exe`。程序使用静态 MSVC 运行库，内置脚本和图标，运行时只需 Windows 系统组件及受支持的 Synapse。

开发测试使用 Node.js 18 或更新版本，无第三方 npm 依赖：

```sh
npm test
```

## 验证范围

已在 Synapse 4.0.896 上应用补丁，真实设备电量 79% 对应 80% 图标，悬停设备名称和实际电量已由用户确认。单文件 EXE 的资源提取、版本识别、管理员授权及“已安装当前版本”的处理路径已验证。

测试覆盖 0–100 的整数电量分档、充电、无效值、设备移除及菜单重建覆盖悬停文字的回归问题。其他电脑和其他 Synapse 版本尚未实测。

## 项目说明

这是个人制作的非官方工具，与 Razer 无隶属或背书关系。Razer 名称和 Logo 属于 Razer Inc.。

仓库包含补丁工具源码及图标资源，不包含 Razer 原程序、驱动、用户配置或运行日志。
