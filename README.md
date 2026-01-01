# 🎮 Matrix Game（博弈论 3×3 对战小游戏）

一个基于 **博弈论矩阵选择** 的双人对战小游戏：

* 两名玩家（A / B）
* A 选择行，B 选择列
* 每个回合 **9 个格子全部刷新**
* 每个格子包含 `(A得分, B得分)`
* 对局共 **9 回合**
* 内置 **公平性算法 + 防滚雪球机制**
* 前后端分离，可部署到云服务器

---

## ✨ 功能特性

* 🧠 **公平博弈生成算法**

  * 行/列期望接近 0
  * 避免“无论怎么选都吃亏”
  * 轻度 rubber-banding（领先方略微吃亏）
* 🔌 **实时对战**

  * Socket.IO 双向通信
* 🏠 **房间系统**

  * 创建房间 / 输入房间号加入
  * 每队只允许 1 人
* 🎨 **简约卡牌 UI**

  * 3×3 棋盘
  * 回合刷新
  * 分数实时结算
* 🚀 **生产级部署**

  * PM2 守护 Node
  * Nginx 反向代理
  * 支持 WebSocket

---

## 🧱 技术栈

### 后端

* Node.js ≥ 18
* Express
* Socket.IO
* PM2

### 前端

* React
* Vite
* 原生 CSS（无 UI 框架）

### 部署

* Ubuntu 22.04
* Nginx

---

## 📁 项目结构

```text
/opt/game
├── server
│   ├── index.js          # 后端主程序（Socket + API + 公平算法）
│   ├── package.json
│   └── node_modules
└── client
    ├── src
    │   ├── App.jsx
    │   ├── socket.js
    │   └── api.js
    ├── index.html
    ├── vite.config.js
    ├── dist               # 前端 build 后产物
    └── package.json
```

---

## ⚙️ 一、服务器环境准备（Ubuntu 22.04）

### 1️⃣ 更新系统

```bash
sudo apt update && sudo apt upgrade -y
```

### 2️⃣ 安装 Node.js 20（推荐）

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node -v
npm -v
```

### 3️⃣ 安装 PM2

```bash
sudo npm i -g pm2
pm2 -v
```

### 4️⃣ 安装 Nginx

```bash
sudo apt install -y nginx
sudo systemctl enable nginx
sudo systemctl start nginx
```

---

## 🖥️ 二、后端部署

### 1️⃣ 进入后端目录

```bash
cd /opt/game/server
```

### 2️⃣ 安装依赖

```bash
npm install
```

### 3️⃣ 启动服务（PM2）

```bash
pm2 start index.js --name matrix-game --cwd /opt/game/server --update-env
pm2 save
```

### 4️⃣ 确认监听端口

```bash
ss -lntp | grep 3000
```

应看到：

```text
LISTEN 0 511 0.0.0.0:3000
```

---

## 🌐 三、前端构建与部署

### 1️⃣ 安装依赖

```bash
cd /opt/game/client
npm install
```

### 2️⃣ 构建生产版本

```bash
npm run build
```

构建完成后生成：

```text
/opt/game/client/dist
```

---

## 🔁 四、Nginx 配置（关键）

### 1️⃣ 创建站点配置

```bash
sudo nano /etc/nginx/sites-available/matrix-game
```

### 2️⃣ 粘贴以下完整配置（⚠️ 必须完整）

```nginx
server {
  listen 80;
  server_name YOUR_SERVER_IP;

  root /opt/game/client/dist;
  index index.html;

  location / {
    try_files $uri $uri/ /index.html;
  }

  location /api/ {
    proxy_pass http://127.0.0.1:3000/api/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
  }

  location /socket.io/ {
    proxy_pass http://127.0.0.1:3000/socket.io/;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "Upgrade";
    proxy_set_header Host $host;
  }
}
```

> 把 `YOUR_SERVER_IP` 改成你的服务器公网 IP

---

### 3️⃣ 启用站点

```bash
sudo rm -f /etc/nginx/sites-enabled/default
sudo ln -s /etc/nginx/sites-available/matrix-game /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

---

## 🔐 五、后端环境变量（CORS / 公平算法）

```bash
export ALLOW_ORIGINS="http://你的IP,http://localhost:5173"
export FAIR_MODE=1
export RUBBER_BAND=1
pm2 restart matrix-game --update-env
```

---

## 🧪 六、连通性测试

### API

```bash
curl -X POST http://你的IP/api/rooms
```

返回示例：

```json
{ "roomId": "A9F3KQ" }
```

### WebSocket

```bash
curl "http://你的IP/socket.io/?EIO=4&transport=polling"
```

---

## 🎯 七、游戏规则（当前版本）

* 每回合：

  * **重新生成 9 个格子**
  * 每格包含 `(A得分, B得分)`
* A 选行（0–2）
* B 选列（0–2）
* 交叉格结算
* 共 **9 回合**
* 最终分数高者获胜

---

## ⚖️ 八、公平性算法说明（简述）

* 多次随机生成候选棋盘
* 评分标准：

  * 行/列均值接近 0
  * 行/列差距不过大
  * 极端值惩罚
* 领先方轻微 bias（防滚雪球）
* 算法参数可通过环境变量调节

---

## 🛠️ 常见问题

### 1️⃣ 前端连不上后端

* 确认：

  * PM2 正在运行
  * Nginx `/api` 和 `/socket.io` 正确转发
  * 前端没有写死 `localhost`

### 2️⃣ 502 Bad Gateway

* 说明 Node 服务未监听 3000 或已崩溃
* 查看：

```bash
pm2 logs matrix-game
```

### 3️⃣ 修改前端后不生效

* 必须重新：

```bash
npm run build
sudo systemctl reload nginx
```

---

## 📌 后续可扩展方向

* 匹配系统（无需房间号）
* AI 对手（minimax / mixed strategy）
* 排行榜
* 观战模式
* 移动端适配
* 回合回放

---

## 📜 License

MIT（可自由使用 / 修改 / 教学 / 部署）

---

如果你愿意，我可以下一步帮你：

* 写 **AI 博弈对手**
* 做 **ELO 排名**
* 或整理成 **教学案例版（博弈论课程用）**

你直接说想做哪一步即可。
