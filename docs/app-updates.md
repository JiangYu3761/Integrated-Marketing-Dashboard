# Mac 应用更新与发布

首次安装当前源码时运行 `安装到Dock.command`，以后从 Dock 打开独立窗口。在管理入口查看「应用更新」，也可以从 Mac 应用菜单点「检查更新」。自动更新默认在启动时和每六小时检查，关闭开关后仍可手动检查。发现正式新版后，应用会等待当前编辑结束并确认资料已落盘，再安装和重启。

## 版本与发布

版本来源是 `desktop/macos/version.json`，采用 `主版本.次版本.修订号`，例如 `1.1.0`、`1.1.1`。发布标签必须对应为 `v1.1.0`、`v1.1.1`，不覆盖已发布版本。

1. 修改版本文件，提交并推送所需代码与测试。
2. 在对应提交创建同版本标签并推送，例如 `git tag v1.1.0`、`git push origin v1.1.0`。也可对已有标签手动运行 **Publish macOS updates** 工作流。
3. 工作流在 `macos-15`（Apple Silicon）与 `macos-15-intel` 上分别编译、签名并启动原生窗口，检查任务及日报草稿的重启恢复。打包后，工作流按用户端读取 ZIP 的方式解包，再次验证签名、可执行文件和架构。
4. 两个平台均成功后，工作流先创建草稿 Release，并一次上传两个安装包和两份清单，再发布为正式最新版。构建失败不会发布半套更新。

工作流使用 GitHub Actions 自带的 `GITHUB_TOKEN` 发布，无需把令牌放入客户端。仓库需要允许工作流发布 Release，且客户端能够公开读取发布资产。首次正式发布前，客户端会显示暂未找到可用更新。

每次发布包含：

| 处理器 | 安装包 | 更新清单 |
| --- | --- | --- |
| Apple Silicon | `MarketingDashboard-macOS-arm64.zip` | `update-macos-arm64.json` |
| Intel | `MarketingDashboard-macOS-x86_64.zip` | `update-macos-x86_64.json` |

客户端从本仓库 `releases/latest/download/update-macos-<arch>.json` 获取版本，并只接受清单中对应 `releases/download/v<version>/` 的固定项目安装包。不会因普通 Git 提交自动升级，不安装较旧版本或预发布版本。

## 安装与失败处理

`desktop/macos/updater.py` 保持默认 HTTPS/TLS 验证，限制 GitHub 下载及跳转主机，核对架构、最低系统版本、包大小、SHA-256、应用标识、代码签名完整性与真实二进制架构。解压禁止越界路径、符号链接及特殊文件，并限制文件数量和总大小。当前采用临时签名，不是 Developer ID 公证；来源信任由固定 GitHub 仓库的 HTTPS 发布提供。

安装包暂存于 `~/Library/Application Support/com.jiangyu3761.integrated-marketing-dashboard/Updates`。独立安装进程接续工作后，应用才退出；安装进程等待旧服务退出，在安装目录同一文件系统暂存并替换 `.app`，重新启动并检查新版项目资源指纹。数据仍使用相同 bundle ID、`127.0.0.1:18876` 和默认 WebKit 存储，不进行数据迁移或清除。

新版启动检查失败时尝试恢复旧 `.app` 并重新打开。失败版本记录阻止反复自动安装，手动检查可重试。文件系统故障导致恢复也失败时，保留 `.dashboard-update-*/previous.app` 供恢复；不会删除该备份来掩盖故障。

## 验证范围

跨平台检查：

```bash
node scripts/check.mjs
python3 -m unittest discover -s tests -p 'test_*.py' -v
```

启动静态服务并提供 Playwright/Chromium 后，运行 `tests/updates.cjs` 与 `tests/day-view.cjs` 验证界面和任务交互。Linux 中的更新事务测试使用应用文件夹样本、受控下载与启动回调，不代替 macOS `codesign` 和 LaunchServices 验证。

Mac 构建后运行 `python3 tests/macos_smoke.py`，会启动两次真实 AppKit/WebKit 应用，验证日格双击、编辑保护、完成勾选/取消、北京时间转换以及退出后重开的存储恢复。数据放在单独的 WebKit 持久化测试配置中，测试结束仅清理该配置，不使用或清除正常应用的用户存储。CI 构建和发布均执行该检查。

发布工作流会从历史提交 `ec5cc16` 编译 1.1.2，在隔离的 WebKit 配置中实际创建任务、记录完成时间，用旧客户端读取本次构建的清单和安装包，替换、启动新版并校验旧数据。测试使用本地供应的发布资产。正式发布后还需核对公开下载地址和散列，以及用户设备上自动检查、关闭自动后的手动更新、编辑中的延后安装、断网和回退表现。
