# Randomly Roll 中文部署教程

本文介绍如何在 Ubuntu 22.04/24.04 上部署 Randomly Roll。部署完成后，同一个域名将同时提供：

- 管理前端：`https://roll.example.com/`
- 后端 API：`https://roll.example.com/api/`
- 健康检查：`https://roll.example.com/health`

推荐架构为：Nginx 提供前端静态文件并反向代理 API，Node.js 后端由 systemd 守护，数据使用 SQLite 和本地文件目录持久化。

> 浏览器调用摄像头时，除 `localhost` 外必须使用 HTTPS。因此正式环境不能只部署 HTTP。

## 1. 部署前准备

准备以下内容：

- 一台可访问公网的 Linux 服务器，建议至少 1 核 CPU、1 GB 内存；
- 一个域名，例如 `roll.example.com`；
- 域名的 A 记录已指向服务器公网 IPv4；
- 服务器已放行 TCP 端口 `22`、`80`、`443`；
- 项目代码已上传或克隆到服务器。

可以先确认 DNS 是否生效：

```bash
dig +short roll.example.com
```

输出应为服务器公网 IP。

## 2. 安装系统依赖

```bash
sudo apt update
sudo apt install -y nginx certbot python3-certbot-nginx curl ca-certificates
```

后端要求 Node.js 22。安装后确认版本：

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node --version
npm --version
```

`node --version` 应显示 `v22.x.x`。

## 3. 放置项目和创建运行用户

本教程假设项目位于 `/opt/randomly-roll`：

```bash
sudo mkdir -p /opt/randomly-roll
sudo mkdir -p /var/lib/randomly-roll/storage
sudo useradd --system --home /var/lib/randomly-roll --shell /usr/sbin/nologin randomly-roll 2>/dev/null || true
sudo chown -R randomly-roll:randomly-roll /opt/randomly-roll /var/lib/randomly-roll
```

将仓库内容上传或克隆到 `/opt/randomly-roll` 后，目录应包含：

```text
/opt/randomly-roll/
├── admin-console/
├── backend/
└── docs/
```

## 4. 配置后端环境变量

```bash
cd /opt/randomly-roll/backend
sudo -u randomly-roll cp .env.example .env
sudo chmod 600 .env
sudo chown randomly-roll:randomly-roll .env
```

编辑 `/opt/randomly-roll/backend/.env`：

```dotenv
PORT=3000
HOST=127.0.0.1
DATABASE_URL=file:/var/lib/randomly-roll/randomly-roll.db
JWT_SECRET=请替换为至少32位的随机字符串
CORS_ORIGINS=https://roll.example.com
DEFAULT_ADMIN_EMAIL=admin@example.com
DEFAULT_ADMIN_PASSWORD=请替换为至少8位的强密码
STORAGE_DIR=/var/lib/randomly-roll/storage
PUBLIC_BASE_URL=https://roll.example.com
```

生成 JWT 密钥：

```bash
openssl rand -hex 32
```

注意：

- 将所有 `roll.example.com` 替换为真实域名；
- 首次初始化数据库前必须修改默认管理员邮箱和密码；
- `.env` 包含密码和密钥，不要提交到 Git；
- 后端只监听 `127.0.0.1:3000`，公网访问统一经过 Nginx。

## 5. 构建并初始化后端

```bash
cd /opt/randomly-roll/backend
sudo -u randomly-roll npm ci
sudo -u randomly-roll npm run db:generate
sudo -u randomly-roll npm run db:push
sudo -u randomly-roll npm run db:seed
sudo -u randomly-roll npm run build
```

临时启动并检查：

```bash
sudo -u randomly-roll node dist/server.js
```

打开另一个终端执行：

```bash
curl http://127.0.0.1:3000/healthz
```

确认返回健康状态后，按 `Ctrl+C` 停止临时进程。

## 6. 使用 systemd 守护后端

创建 `/etc/systemd/system/randomly-roll.service`：

```ini
[Unit]
Description=Randomly Roll Backend
After=network.target

[Service]
Type=simple
User=randomly-roll
Group=randomly-roll
WorkingDirectory=/opt/randomly-roll/backend
Environment=NODE_ENV=production
EnvironmentFile=/opt/randomly-roll/backend/.env
ExecStart=/usr/bin/node /opt/randomly-roll/backend/dist/server.js
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/randomly-roll

[Install]
WantedBy=multi-user.target
```

加载并启动服务：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now randomly-roll
sudo systemctl status randomly-roll --no-pager
```

查看实时日志：

```bash
sudo journalctl -u randomly-roll -f
```

## 7. 构建管理前端

```bash
cd /opt/randomly-roll/admin-console
sudo -u randomly-roll npm ci
sudo -u randomly-roll npm run build
sudo mkdir -p /var/www/randomly-roll-admin
sudo cp -a dist/. /var/www/randomly-roll-admin/
sudo chown -R www-data:www-data /var/www/randomly-roll-admin
```

前端第一次打开时，在登录页面底部将“服务地址”设置为：

```text
https://roll.example.com
```

浏览器会在本机保存该地址，后续请求自动访问同域名下的 API。

## 8. 配置 Nginx 和域名

仓库已提供单域名配置模板：

```bash
sudo cp /opt/randomly-roll/backend/deploy/nginx.randomly-roll.conf /etc/nginx/sites-available/randomly-roll
sudo sed -i 's/roll\.example\.com/你的真实域名/g' /etc/nginx/sites-available/randomly-roll
sudo ln -s /etc/nginx/sites-available/randomly-roll /etc/nginx/sites-enabled/randomly-roll
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx
```

如果不希望使用 `sed`，也可以直接编辑配置文件中的 `server_name`。

此时可先通过 HTTP 检查：

```bash
curl http://roll.example.com/health
```

## 9. 申请 HTTPS 证书

确认域名已经解析到服务器，且 80 端口可访问后执行：

```bash
sudo certbot --nginx -d roll.example.com
```

Certbot 会自动修改 Nginx 配置并启用 HTTP 到 HTTPS 跳转。验证自动续期：

```bash
sudo certbot renew --dry-run
```

最终检查：

```bash
curl https://roll.example.com/health
```

然后用浏览器访问 `https://roll.example.com`，登录并测试摄像头授权、人脸采集和名册同步。

## 10. 防火墙配置

如果使用 UFW：

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
sudo ufw status
```

不要对公网开放 `3000` 端口。

## 11. 更新版本

更新代码后执行：

```bash
cd /opt/randomly-roll/backend
sudo -u randomly-roll npm ci
sudo -u randomly-roll npm run db:generate
sudo -u randomly-roll npm run db:push
sudo -u randomly-roll npm run build
sudo systemctl restart randomly-roll

cd /opt/randomly-roll/admin-console
sudo -u randomly-roll npm ci
sudo -u randomly-roll npm run build
sudo cp -a dist/. /var/www/randomly-roll-admin/
sudo chown -R www-data:www-data /var/www/randomly-roll-admin
sudo systemctl reload nginx
```

更新后检查：

```bash
sudo systemctl status randomly-roll --no-pager
curl https://roll.example.com/health
```

## 12. 数据备份与恢复

需要备份两类数据：

- SQLite 数据库：`/var/lib/randomly-roll/randomly-roll.db`
- 人脸上传文件：`/var/lib/randomly-roll/storage/`

建议停止后端后制作一致性备份：

```bash
sudo systemctl stop randomly-roll
sudo tar -czf /var/backups/randomly-roll-$(date +%F-%H%M).tar.gz /var/lib/randomly-roll
sudo systemctl start randomly-roll
```

恢复时先停止服务，解压备份并确认目录所有者为 `randomly-roll:randomly-roll`，然后重新启动服务。

## 13. 常见问题

### 页面可以打开，但登录失败

检查登录页底部的服务地址是否为当前域名，并查看：

```bash
sudo journalctl -u randomly-roll -n 100 --no-pager
sudo tail -n 100 /var/log/nginx/error.log
```

### 摄像头无法打开

确认页面通过 HTTPS 访问，并在浏览器地址栏中允许摄像头权限。摄像头不可被其他程序独占。

### 上传返回 413

Nginx 模板默认限制为 20 MB。需要更大容量时修改：

```nginx
client_max_body_size 20m;
```

修改后执行 `sudo nginx -t && sudo systemctl reload nginx`。

### 数据库无写入权限

```bash
sudo chown -R randomly-roll:randomly-roll /var/lib/randomly-roll
sudo systemctl restart randomly-roll
```

## 14. 当前生产限制

- 当前人脸描述符提取器仍是确定性占位实现，不是真实的人脸向量模型。正式用于识别前，需要替换 `backend/src/lib/descriptors.ts` 中的实现。
- 邮件发送服务尚未接入，注册验证码和密码重置凭据会由 API 返回并在前端自动填入。该模式仅适合内网或受控环境；公开互联网部署前，应接入邮件服务并停止在 API 响应中返回验证码和重置凭据。
- 当前数据库为 SQLite，适合单机和中小规模使用。需要多实例或高并发时，应迁移到 PostgreSQL 并重新评估文件存储方案。
