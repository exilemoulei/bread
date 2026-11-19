# bread (`bili`)

零依赖的 B 站原生全模态视频理解命令行工具。通过 `yt-dlp` 拉流并直连阿里云百炼全模态模型（默认 `qwen3.8-omni-flash`），同时理解视频画面（PPT、代码、界面小字）与音轨语音，输出结构化中文总结、带 `[mm:ss]` 时间戳的要点、指定片段高清精读或多视频对比。

## 特性

- **零第三方 npm 依赖**：纯 Node.js ESM 实现，使用内置 `node:https` 直连 B 站与百炼，自动隔离环境代理变量，避免国内链路走代理超时或中断。
- **42h OSS 缓存 + Prefix Cache**：全片上传生成的临时 `oss://` 地址按 `bvid + cid + quality + model` 本地缓存 42 小时，同视频追问免重复下载上传，并固定 `[video_url, text]` 消息顺序复用服务端前缀缓存；缓存失效时自动重传自愈。
- **窄时间窗高清切片快路径**：当 `-q` 提问命中 `<= 180s` 的局部时间点/区间（或显式传 `--clip`）时，自动按 1080p + `1.0 fps` + 深度思考拉取局部切片，并自动换算原片绝对时间戳。
- **自适应 Token 预算**：根据视频总时长与目标模型上下文上限自动调节画质与抽帧率，支持单视频最长 2 小时（`qwen3.8-omni-flash`）及多视频并行对比。
- **元数据校准**：自动拉取 B 站标题、UP 主、分 P 与简介作为辅助上下文，减少专有名词与人名同音误识。

## 环境要求

- **Node.js** `>= 20.11`（推荐 Node 22+ / 24）
- **yt-dlp**（在 `PATH` 中、`python -m yt_dlp`，或通过 `BILI_YTDLP_BIN` 指定）
- **ffmpeg**（供 `yt-dlp` 合并音视频流及 `--clip` 精确切片）
- **阿里云百炼（DashScope）API Key**

## 配置 API Key

支持以下任一方式（按优先级从高到低读取）：

1. 命令行参数：`--key <your-api-key>`
2. 环境变量：`DASHSCOPE_API_KEY` 或 `BAILIAN_API_KEY`
3. 本地凭证文件：`~/.gemini/config/bailian-api-key.csv`（或 `.txt`），兼容纯文本单行 Key 或阿里云百炼控制台导出的纵向 `key,value` CSV

```bash
export DASHSCOPE_API_KEY="sk-xxxxxxxx"
```

## 快速开始

```bash
# 克隆仓库
git clone https://github.com/exilemoulei/bread.git
cd bread

# 可选：全局安装 bili 命令
npm link

# 直接运行（不全局安装也可通过 node src/cli.mjs 调用）
bili BV16Xbm6VEzd
```

## 常用示例

```bash
# 1. 全片结构化总结（支持完整 URL、b23.tv 短链、BV 号、av 号）
bili "https://www.bilibili.com/video/BV16Xbm6VEzd"

# 2. 针对已缓存视频追问（复用本地 oss:// 缓存，强制走全片）
bili BV16Xbm6VEzd --no-clip -q "总结最后 10 分钟的核心结论"

# 3. 局部时间点/小字高清精读（自动触发 1080p 切片快路径）
bili BV16Xbm6VEzd -q "15:00到15:20画面右上角和主标题写了什么？"

# 4. 显式指定切片区间与深度思考
bili BV16Xbm6VEzd --clip 14:50-15:30 --deep -q "逐项整理这一段展示的参数"

# 5. 多视频对比 / 指定分 P / 输出 JSON 或写入文件
bili BV1xxxxxxxx1 BV1xxxxxxxx2 -q "对比两期视频的核心观点差异"
bili BV16Xbm6VEzd -p 2 --json --out result.json

# 6. 遇到 B 站风控（412）时透传浏览器 Cookies
bili BV16Xbm6VEzd --cookies edge
```

## 常用参数

| 参数 | 说明 |
|---|---|
| `-q, --ask <text>` | 自定义问题；单视频含 `<=180s` 窄时间窗且未传 `--no-clip` 时自动走高清切片 |
| `-p, --page <N>` | 指定分 P 序号（默认读取 URL 中的 `?p=N`，否则为 1） |
| `--deep` | 开启模型深度思考模式（`enable_thinking: true`） |
| `--clip <start-end>` | 显式截取时间段（如 `14:50-15:30` 或 `900-930`），默认 1080p / `1.0 fps` |
| `--no-clip` | 即使 `-q` 包含时间戳，也强制分析全片 |
| `--quality <1080\|720\|480\|360>` | 覆盖视频画质上限 |
| `--fps <num>` | 覆盖视频抽帧率 |
| `--model <id>` | 指定百炼模型 ID（默认 `qwen3.8-omni-flash`） |
| `--no-cache` | 忽略本地 `oss://` 缓存，重新拉流上传并刷新缓存 |
| `--cookies <browser\|file>` | 透传给 `yt-dlp`（浏览器名如 `edge`/`chrome` 或 `cookies.txt` 路径） |
| `--key <key>` | 显式传入百炼 API Key |
| `--json` | 输出包含元数据、缓存命中、分阶段耗时与 Token 用量的结构化 JSON |
| `--out <file>` | 将输出以 UTF-8 写入指定文件 |

### 退出码

- `0`：成功
- `2`：参数校验失败或缺少 API Key
- `3`：B 站拉流失败或百炼接口报错
- `4`：请求或拉流超时

## 开发与测试

```bash
# 运行离线单元测试（无需网络与 API Key）
npm test

# 运行端到端真机冒烟测试（需要网络与有效百炼 API Key）
npm run smoke
```

## 目录结构

```text
src/
  cli.mjs             # CLI 入口、参数解析、全片/切片调度与缓存自愈
  bilibili.mjs        # BV/av/短链解析、元数据获取与 yt-dlp 拉流
  bailian.mjs         # 凭证加载、直连 HTTPS、OSS 流式上传与 SSE 解析
  cache.mjs           # 本地 42h oss:// 缓存索引（原子写入）
  prompt-builder.mjs  # 窄时间窗识别、Token 预算规划与消息组装
test/
  unit.test.mjs       # 离线单元测试
  e2e.smoke.mjs       # 端到端真机冒烟脚本
```

## License

[MIT](./LICENSE)
