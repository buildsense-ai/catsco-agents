#!/usr/bin/env bash
# 部署 catsco-agents 服务运行时到单台实例（在跳板机 cats-ctyun 上执行）。
# 用法：bash deploy-runtime-instance.sh <host-ip>
set -euo pipefail
host="${1:?usage: deploy-runtime-instance.sh <host-ip>}"
key=/opt/catscompany/keys/catsco-agents-key.pem
sshopt="-i $key -o StrictHostKeyChecking=no -o ConnectTimeout=15"

echo "== [$host] copy tarball =="
scp $sshopt /tmp/catsco-agents-runtime.tar.gz "root@$host:/tmp/catsco-agents-runtime.tar.gz"

echo "== [$host] deploy =="
ssh $sshopt "root@$host" 'bash -s' <<'REMOTE'
set -e
mkdir -p /opt/catsco-agents/pkgs
cd /opt/catsco-agents
if [ -f pkgs/catsco-agents-runtime.tar.gz ]; then
  mv -f pkgs/catsco-agents-runtime.tar.gz pkgs/catsco-agents-runtime-prev.tar.gz
fi
mv -f /tmp/catsco-agents-runtime.tar.gz pkgs/catsco-agents-runtime.tar.gz
systemctl stop catsco-service-runtime || true
rm -rf runtime/dist runtime/node_modules
tar xzf pkgs/catsco-agents-runtime.tar.gz -C /opt/catsco-agents
chown -R catsco:catsco runtime
systemctl start catsco-service-runtime
sleep 4
echo "service=$(systemctl is-active catsco-service-runtime)"
echo "--- log tail ---"
journalctl -u catsco-service-runtime --since '45 seconds ago' --no-pager | tail -8
REMOTE
echo "== [$host] done =="
