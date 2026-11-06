# 笺 · 同步服务器

让电脑上的笺和手机同步，并把手机网页版（可以添加到主屏幕，像 App 一样用）托管在同一个地址上。

- 同步只用 Python 3 标准库；常驻内存约 30 MB。
- 手机提醒（推送通知）另需 `python3-cryptography`（Debian / Ubuntu 自带的包，`apt install python3-cryptography`）。没有它也能同步，只是收不到提醒。
- 数据存在服务器的 `/var/lib/jian-sync/`：
  - `doc.json`：同步的数据；
  - `auth.json`：同步密码的哈希和各设备令牌的哈希；
  - `push.json`、`vapid.pem`：手机的推送订阅、服务器的推送签名密钥；
  - `backups/`：每天一份，保留 30 天。
- 只同步日程、小任务和随记。设置（纸色、时区等）留在各自设备上。
- 合并按「每一条」来：两边改了不同的条目都会保留；同一条两边都改了，以后改的为准。规则见 `../syncmerge.py`。

## 第一次部署前（服务器上，只需一次）

1. **开防火墙端口。**
   - 8443：给笺用。
   - 80：只在申请和续期证书时用。

   ```sh
   ufw allow 8443/tcp comment 'jian sync'
   ufw allow 80/tcp comment 'jian acme'
   ```

2. **装 [lego](https://github.com/go-acme/lego/releases)（v5）到 `/usr/local/bin/lego`，并注册账号：**

   ```sh
   lego accounts register --accept-tos --account-id jian --path /etc/jian-sync/lego
   ```

   - 没有域名也可以直接给 IP 申请证书（Let's Encrypt 短期证书，自动续期）。
   - 账号可以不留邮箱。

## 部署 / 更新（在电脑上运行）

```sh
server/deploy.sh root@服务器IP          # 有域名就加第二个参数：server/deploy.sh root@IP 域名
```

脚本会：

- 构建手机网页版；
- 上传程序到 `/opt/jian-sync`；
- 建好系统用户 `jian` 和数据目录；
- 申请证书（如果还没有）；
- 装好并启动 `jian-sync.service`，以及每天检查两次证书的 `jian-cert.timer`。

可以重复运行，数据不受影响。

## 密码与设备

在服务器上运行：

```sh
cd /var/lib/jian-sync
runuser -u jian -- python3 /opt/jian-sync/server/jian_sync.py passwd --state . --random   # 生成并设置同步密码（手机登录用）
runuser -u jian -- python3 /opt/jian-sync/server/jian_sync.py token  --state . 电脑       # 给电脑生成一个令牌
runuser -u jian -- python3 /opt/jian-sync/server/jian_sync.py tokens --state .           # 看有哪些设备
runuser -u jian -- python3 /opt/jian-sync/server/jian_sync.py revoke --state . iPhone    # 注销某台设备（比如手机丢了）
```

- **电脑**：把地址和令牌写进 `~/.local/share/jian/sync.json`，然后重启笺。之后会自动同步，设置里能看到同步状态。

  ```json
  {"url": "https://服务器IP:8443", "token": "上面生成的令牌"}
  ```

- **手机**：
  1. 用 Safari 打开 `https://服务器IP:8443`，输入同步密码。
  2. 点「分享 → 添加到主屏幕」。
  3. 之后从主屏幕打开，没网也能看、能改，联网后自动同步。
  4. 想收日程提醒：设置 → 提前提醒 → 点「开启」，允许通知（iOS 16.4 以上）。
     - 到点由服务器推送，App 没开着也能收到。
     - 提前几分钟、按哪个时区，都跟手机上的设置走。

  手机上的两个视图：

  - **日视图**：当天的待办和日程方块；左右滑动换到前一天 / 后一天。
  - **周视图**：
    - 左右滑看别的日子，滑过一周的边缘就翻到上一周或下一周。
    - 两指捏合，调整一屏显示几天。
    - 点空白处新建日程，点日程修改它。
    - 按住日程约半秒拿起来，可以拖到别的时间或别的日子；按住底边拖动可以拉长、缩短。
  - 从底部升起的卡片（编辑日程、设置）往下一拖就收起。

## 运行日志

```sh
journalctl -u jian-sync -f          # 每个请求一行：来源 IP、路径、状态码
journalctl -u jian-cert             # 证书续期记录
```
