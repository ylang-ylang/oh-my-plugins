# omp-lan-rpc

为正在运行的普通 OMP 会话提供带认证的本机／局域网消息接口。安装后新启动的交互式 OMP 会话自动加载插件，不需要 watchdog，也不需要把 OMP 改成 `--mode rpc`。

## 安装前先检查依赖

**在运行 OMP 的那台机器上执行下面的步骤，不是在另一台开发机上安装依赖。**

| 依赖 | 用途 |
| --- | --- |
| 已安装且能正常使用的 OMP | 宿主会话；本插件不是 OMP 本体的安装器 |
| Git | 从 GitHub 安装插件 |
| Bun | OMP 18.2.6 的插件安装器需要 PATH 中存在 `bun`；近期 OMP 版本已改用内嵌 Bun |
| Node.js ≥22 | 运行独立命令行客户端 |
| Homebrew（可选） | 安装 Bun、Git、Node 的一种方式；不是插件运行依赖 |
| OpenSSL（开启局域网时） | 如果没有现成 TLS 证书，可用它生成证书 |
| Nerd Fonts 字体（图标显示） | 显示 OMP 的终端需支持 `md-radar`（U+F0437）；SSH 场景在客户端终端配置字体，不影响网络接口功能 |

如果看到：

```text
Executable not found in $PATH: "bun"
```

这是 OMP 安装器在**下载插件之前**找不到 Bun，插件自身还没有机会运行或提示。先完成下方 Bun 安装与 PATH 配置，再重试。不要通过反复重新安装插件解决这个前置依赖问题。

## 方式 A：通过 Homebrew 安装依赖

已有 `brew` 的机器直接跳到第 3 步。没有 Homebrew 但只想补 Bun，也可以选择后面的方式 B。

### 1. 安装 Homebrew

在普通用户账户下执行，不要用 `sudo` 运行 Homebrew 安装器或 `brew install`。安装器会在必要时自行请求提权。

Ubuntu／Debian 如果缺少基础工具，先安装：

```bash
sudo apt-get update
sudo apt-get install -y build-essential procps curl file git ca-certificates unzip
```

其他 Linux 发行版按其包管理器准备对应依赖；参见 [Homebrew on Linux](https://docs.brew.sh/Homebrew-on-Linux)。macOS 按安装器提示准备开发工具；需要时运行 `xcode-select --install`，完成系统安装窗口后继续。

Linux／macOS 官方 Homebrew 安装命令：

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

这会下载并执行官方安装脚本；需要网络可访问 GitHub。具体平台支持范围和安装要求见 [Homebrew 官方安装说明](https://docs.brew.sh/Installation)。

### 2. 配置 Homebrew 的 PATH

**以安装器最后输出的 Next steps 为准。** 常见默认路径如下，只执行与你的系统匹配的一条：

Linux：

```bash
eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"
```

macOS Apple Silicon：

```bash
eval "$(/opt/homebrew/bin/brew shellenv)"
```

macOS Intel 的传统默认路径：

```bash
eval "$(/usr/local/bin/brew shellenv)"
```

上面的 `eval` 只影响当前终端。将对应的**同一行原文**添加一次到 shell 启动文件：Bash 通常为 `~/.bashrc`，Zsh 通常为 `~/.zshrc`；macOS 登录 Zsh 按安装器提示使用 `~/.zprofile`。不要把命令展开后的输出粘贴进去，也不要重复添加已有配置。

重新打开终端后检查：

```bash
brew --version
```

### 3. 安装 Bun、Git 和 Node

```bash
brew install oven-sh/bun/bun
```

如果尚未安装 Git 或 Node.js ≥22：

```bash
brew install git node
```

确认当前 shell 确实能找到它们：

```bash
command -v bun
bun --version
git --version
node --version
```

如果 `brew` 可用但 `bun` 仍找不到，重新加载上一步的 `brew shellenv`，再打开新终端。旧 tmux pane 和已运行的 OMP 进程不会自动获得更新后的环境；重新启动对应终端／OMP。

## 方式 B：直接安装 Bun，不安装 Homebrew

此方式不需要 Homebrew，但仍需要已有 Git，以及运行客户端时所需的 Node.js ≥22。

Linux 的官方安装脚本需要 `unzip`。Ubuntu／Debian 可先执行：

```bash
sudo apt-get update
sudo apt-get install -y curl ca-certificates unzip git
```

使用 [Bun 官方安装脚本](https://bun.com/docs/installation)：

```bash
curl -fsSL https://bun.com/install | bash
```

如果安装后当前终端仍找不到 Bun：

```bash
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
```

如果安装器尚未写入 shell 配置，将这两行原文添加一次到 `~/.bashrc` 或 `~/.zshrc`，再打开新终端。

```bash
bun --version
```

也可以在已有 npm 的机器使用 `npm install -g bun`。如果新版 npm 提示 Bun 的安装脚本未获准，按提示仅允许 Bun 的脚本，例如 `npm rebuild --global --allow-scripts=bun bun`，随后再次检查 `bun --version`。不要为了安装这个插件放开所有包的安装脚本。

## 一条命令安装插件

依赖就绪后：

```bash
omp plugin install github:ylang-ylang/omp-lan-rpc
```

已安装旧版时，可指定本次版本，避免继续使用旧的 Git 依赖缓存：

```bash
omp plugin install 'github:ylang-ylang/omp-lan-rpc#v0.2.0'
```

重新启动普通 OMP：

```bash
omp
```

**安装或升级后请完整退出并重新运行 OMP。** 雷达布局在原生状态栏创建前准备；仅 `/reload-plugins` 或 `/lan restart` 不会重建旧版本已经创建的状态栏。`/lan restart` 只重启网络入口。

在会话内查看或控制入口：

```text
/lan
/lan info
/lan on
/lan off
/lan stop
/lan restart
```

安装后默认仅监听 `127.0.0.1`，使用随机空闲端口。**安装成功不等于已经向局域网开放。** 每个会话拥有独立的实例 ID 和令牌。

状态栏只显示一个小雷达图标，不再常驻显示完整地址。`/lan` 打开控制菜单；地址、实例 ID 和请求状态在 `/lan info` 中查看。
雷达使用 Nerd Fonts 的 `md-radar` 字形，颜色遵循 OMP 原生主题；本机与局域网状态在菜单中区分。停止时显示小圆点，错误时显示 `!`。如果雷达显示成方框，请为显示 OMP 的终端选择支持该字形的 [Nerd Font](https://www.nerdfonts.com/)；SSH 场景需要配置本地客户端的终端字体，而不是给远程服务器安装字体。

- `/lan on`：开启局域网；首次使用会依次询问本机 IP、端口、TLS 证书和私钥路径，并在开启前确认。
- `/lan off`：关闭局域网，保留本机接口；已配置的局域网 IP 和证书路径不会丢失。
- `/lan configure`：修改参数并开启局域网。
- `/lan start`、`/lan stop`、`/lan restart`：启动、停止、重启当前会话的接入服务。

局域网开关会保存为后续新会话的默认值，并立即重启当前入口；其他已经运行的会话不会被自动修改。重启会更换令牌。待处理请求未结束时，不允许切换会话或重新配置；可以等待完成，或明确执行 `/lan stop`。旧的 `/lan-rpc` 命令已替换为 `/lan`。

## 客户端与局域网访问

默认用户安装路径下，可以这样查看完整操作说明：

```bash
node ~/.omp/plugins/node_modules/omp-lan-rpc/cli.mjs help
```

自定义 OMP／XDG 数据目录时，插件安装路径会不同。客户端提供 `list`、`session`、`send`、`request` 和 `config` 命令；`help` 包含完整示例。

局域网直连必须同时配置监听 IP、TLS 证书和私钥，例如在 OMP 所在机器执行（替换示例 IP 和证书路径）：

```bash
node ~/.omp/plugins/node_modules/omp-lan-rpc/cli.mjs config \
  --host 192.0.2.10 --port 0 \
  --tls-cert /absolute/path/server.crt \
  --tls-key /absolute/path/server.key
```

随后重启 OMP 或执行 `/lan restart`；也可以直接在 OMP 内使用 `/lan` 菜单完成配置。证书 SAN 必须匹配客户端使用的 IP／主机名；自签证书的客户端需要 `--ca`。`--port 0` 允许多个会话各自选择空闲端口，固定端口则不能被多个会话同时占用。也可以通过 SSH 隧道访问默认本机监听端口，而不直接开放局域网。

默认配置及运行目录为 `~/.omp/lan-rpc`，可由 `OMP_LAN_RPC_DIR` 指定。实例元数据和令牌分别位于 `instances/<instance-id>.json` 和同名 `.token` 文件中。只通过 SSH/SCP 等安全通道传递令牌；不要把令牌、TLS 私钥或运行目录提交到仓库。

## 边界与安全

- 这是消息级 HTTP/JSON 接口，不是 OMP 原生 stdio RPC 的完整网络映射。
- 令牌允许驱动该 agent 及其已有工具能力；它不是沙箱，只应交给可信调用方。
- 请求忙时排队；同一代次内按请求 ID 去重。最多 64 个未完成请求、256 条请求记录。
- 请求记录保存在内存。退出、切换会话或重启接口后，实例和令牌会变更。
- 响应丢失后，先查询原实例／代次；不能把向新会话重发相同 ID 当成跨重启的恰好一次执行。
- `/lan stop` 关闭入口，但不会撤销已经发生的工具副作用。

## 开发

```bash
omp plugin link /absolute/path/to/omp-lan-rpc
npm test
```

已验证宿主 OMP 18.2.6；客户端要求 Node.js ≥22。项目没有第三方运行时 npm 依赖。
