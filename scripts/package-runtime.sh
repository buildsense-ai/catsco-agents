#!/usr/bin/env bash
# 打包服务运行时部署包（本地执行；产物 tar 经跳板机分发到实例）。
# 用法：bash scripts/package-runtime.sh [输出目录]
# 产物：<输出目录>/catsco-agents-runtime.tar.gz（runtime/{dist,agents,node_modules,package.json}）
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
out="${1:-$root/dist-package}"
registry="${NPM_REGISTRY:-https://registry.npmmirror.com}"

echo "== build =="
cd "$root"
npm run build

echo "== stage =="
rm -rf "$out"
mkdir -p "$out/runtime"
cp -R dist agents package.json package-lock.json "$out/runtime/"

echo "== production deps =="
cd "$out/runtime"
npm ci --omit=dev --registry="$registry" --no-audit --fund=false

echo "== archive =="
cd "$out"
tar czf catsco-agents-runtime.tar.gz runtime
echo "package: $out/catsco-agents-runtime.tar.gz ($(du -h "$out/catsco-agents-runtime.tar.gz" | cut -f1))"
