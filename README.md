# MJJ提醒系统 (MyMsgPush)

> 🔔 一个轻量级的提醒推送系统，支持多种通知渠道，内置管理后台。

基于 [deadline](https://github.com/1143520/deadline) 项目重构，从 Cloudflare Pages 架构迁移至 **Node.js + Express + SQLite** 纯本地化方案，开箱即用。

## ✨ 功能特性

- 📋 **提醒管理** — 卡片式前台 + 管理后台，支持增删查
- 🔁 **循环提醒** — 单次 / 每周 / 每月 / 每年
- ⏱️ **自动推送** — 内置 `node-cron` 每分钟检查，到期自动推送
- 📡 **6种通知渠道** — Telegram / 企业微信 / Bark / 飞书 / 钉钉 / 自定义Webhook
- 🔐 **前台密码保护** — 可在后台设置前台访问密码
- 🛡️ **管理后台** — 暗色主题后台，统计 / 渠道配置 / 通知日志 / 测试发送
- 💾 **SQLite 持久化** — 使用 `sql.js`，无需编译，跨平台运行

## 📸 截图预览

| 前台（密码保护） | 管理后台 | 通知渠道配置 |
|:---:|:---:|:---:|
| 🔒 密码遮罩 | 📊 卡片式提醒 | 📡 6种渠道 |

## 🚀 快速部署

### 环境要求

- **Node.js** >= 16.x
- **npm** >= 7.x

### 1. 克隆项目

```bash
git clone https://github.com/logdns/mymsgoush.git
cd mymsgoush
```

### 2. 安装依赖

```bash
npm install
```

### 3. 启动服务

```bash
node server.js
```

服务默认运行在 **3009** 端口：

- 🏠 前台地址：`http://你的IP:3009`
- ⚙️ 后台地址：`http://你的IP:3009/admin.html`

### 4. 默认账号

| 类型 | 账号/密码 |
|------|----------|
| 后台管理员 | `admin` / `admin123` |
| 前台访问密码 | `mjj123` |

> ⚠️ **首次登录后请立即修改默认密码！**

## 🖥️ 生产环境部署

### 使用 PM2 守护进程

```bash
# 安装 PM2
npm install -g pm2

# 启动应用
pm2 start server.js --name mymsgpush

# 设置开机自启
pm2 save
pm2 startup
```

### PM2 常用命令

```bash
pm2 status          # 查看状态
pm2 logs mymsgpush  # 查看日志
pm2 restart mymsgpush  # 重启
pm2 stop mymsgpush     # 停止
```

## 🐧 宝塔面板部署

### 方法一：Node.js 项目管理器（推荐）

1. **安装 Node.js**
   - 宝塔面板 → 软件商店 → 搜索 `Node.js版本管理器` → 安装
   - 进入管理器，安装 Node.js `18.x` 或 `20.x`

2. **上传项目**
   ```bash
   # SSH 连接服务器
   cd /www/wwwroot
   git clone https://github.com/logdns/mymsgoush.git
   cd mymsgoush
   npm install
   ```

3. **添加 Node 项目**
   - 宝塔面板 → 网站 → Node项目 → 添加Node项目
   - 项目目录：`/www/wwwroot/mymsgpush`
   - 启动文件：`server.js`
   - 端口：`3009`
   - 运行用户：`root`
   - 点击「提交」

4. **配置反向代理（可选，绑定域名）**
   - 宝塔面板 → 网站 → 添加站点 → 填写域名
   - 进入站点设置 → 反向代理 → 添加反向代理
   - 代理名称：`mymsgpush`
   - 目标URL：`http://127.0.0.1:3009`
   - 发送域名：`$host`

5. **配置 SSL（可选）**
   - 站点设置 → SSL → Let's Encrypt → 申请证书
   - 开启强制 HTTPS

### 方法二：手动 PM2 部署

1. **安装 Node.js 和 PM2**
   ```bash
   # 通过宝塔安装 Node.js 后
   npm install -g pm2
   ```

2. **部署项目**
   ```bash
   cd /www/wwwroot
   git clone https://github.com/logdns/mymsgoush.git
   cd mymsgoush
   npm install
   pm2 start server.js --name mymsgpush
   pm2 save
   pm2 startup
   ```

3. **宝塔放行端口**
   - 宝塔面板 → 安全 → 系统防火墙 → 放行端口 `3009`

4. **配置反向代理**
   - 同方法一步骤4

### 宝塔 Nginx 反向代理配置参考

```nginx
location / {
    proxy_pass http://127.0.0.1:3009;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
}
```

## 📁 项目结构

```
mymsgpush/
├── server.js          # 入口文件
├── db.js              # 数据库模块 (sql.js)
├── scheduler.js       # 定时任务调度
├── notifier.js        # 通知发送模块
├── package.json       # 依赖配置
├── routes/
│   ├── admin.js       # 管理后台 API
│   ├── auth.js        # 前台密码验证
│   ├── notify.js      # 通知触发 API
│   └── reminders.js   # 提醒 CRUD API
├── public/
│   ├── index.html     # 前台页面
│   ├── admin.html     # 管理后台
│   ├── style.css      # 前台样式
│   ├── logo.png       # Logo
│   └── bg.png         # 背景图
└── data/
    └── reminders.db   # SQLite 数据库（自动生成）
```

## 📡 通知渠道配置

在后台 `📡 通知渠道` 页面配置：

| 渠道 | 配置项 |
|------|--------|
| Telegram | Bot Token + Chat ID |
| 企业微信 | Webhook URL |
| Bark | 推送地址 + Key |
| 飞书 | Webhook URL |
| 钉钉 | Webhook URL |
| 自定义Webhook | URL + Method + Content-Type + Body模板 |

> 💡 Body模板使用 `{{message}}` 作为消息内容占位符

## 🔧 API 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/reminders` | 获取提醒列表 |
| POST | `/api/reminders` | 添加提醒 |
| DELETE | `/api/reminders/:id` | 删除提醒 |
| POST | `/api/verify-password` | 验证前台密码 |
| POST | `/api/notify/trigger` | 手动触发通知检查 |

## 🙏 鸣谢

本项目基于以下开源项目重构：

- [deadline](https://github.com/1143520/deadline) — 原始项目
- [deadline (logdns fork)](https://github.com/logdns/deadline) — Fork 版本

感谢原作者的创意和贡献！

## 📄 License

MIT License
