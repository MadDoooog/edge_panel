# edge-panel

浏览器新标签页面板，功能：
1. **定时采集** 本机及远程服务器的磁盘、CPU、内存数据（通过 SSH）
2. **新标签页** 展示 Google / Bing 搜索栏 + 服务器状态面板

## 目录结构

```
edge-panel/
├── config.yaml          # 配置：服务器列表、端口、采集间隔
├── requirements.txt
├── run.py               # 启动入口
├── backend/
│   ├── main.py          # FastAPI 应用 + 生命周期
│   ├── scheduler.py     # APScheduler 定时采集
│   ├── storage.py       # 数据持久化（data/metrics.json）
│   ├── config.py        # 配置加载
│   └── collectors/
│       ├── local.py     # 本机采集（psutil）
│       └── ssh.py       # SSH 远程采集（paramiko）
└── frontend/
    ├── index.html       # 新标签页
    ├── style.css
    └── script.js
```

## 快速开始

### 1. 安装依赖（首次）

```bash
cd edge-panel
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

### 2. 编辑配置

修改 `config.yaml`：

```yaml
# 只需改这里就能切换所有服务器的账号密码
ssh_defaults:
  username: "your_username"
  password: "your_password"

# 需要用 du -sh 检查的目录
du_paths:
  - "/home/your_data_dir"

targets:
  - name: "server-01"
    type: ssh
    host: "server-01.example.com"
    port: 22
  # 各 target 可单独写 username/password 覆盖 ssh_defaults
```

### 3. 启动后端

```bash
.venv/bin/python run.py
```

后端默认监听 `http://127.0.0.1:8765`，同时提供前端静态文件服务。

### 4. 设置为 Edge 新标签页

**方法 A（推荐）**：使用 [Custom New Tab URL](https://microsoftedge.microsoft.com/addons/detail/custom-new-tab-url/hdmbdioamgdkppmocchpkjobcdodfpkj) 扩展，将 URL 设置为：
```
http://127.0.0.1:8765/
```

**方法 B**：直接在 Edge 地址栏打开 `http://127.0.0.1:8765/`，然后固定为主页。

## 数据刷新

- 后端定时采集：默认每 **5 分钟**（可在 `config.yaml` 中修改 `schedule.interval_minutes`）
- 前端自动刷新：每 **60 秒** 从 API 拉取最新数据
- 点击面板右上角 **↻** 按钮可立即刷新

