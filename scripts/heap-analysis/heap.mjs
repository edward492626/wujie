#!/usr/bin/env node
/**
 * Chrome DevTools .heapsnapshot 离线分析工具（wujie 微前端内存泄漏排查专用增强）
 *
 * 用法: node --max-old-space-size=8192 heap.mjs <子命令> <快照文件> [参数...]
 * 详见同目录 README.md
 */
import fs from "fs";
import { fileURLToPath } from "url";

const HELP = `用法: node --max-old-space-size=8192 heap.mjs <cmd> <snapshot.heapsnapshot> [args]

命令:
  meta <file>                              打印快照格式元信息(字段/类型表)
  stats <file>                             总览: 节点数/可达率/关键类别计数/detached 统计
  wujie <file>                             wujie 专项: _hasPatch 壳数 / __WUJIE 边 / ShadowRoot 分布
  strings <file> <needle>                  在字符串表中检索关键字(验证线上代码指纹)
  byname <file> [out.tsv]                  按节点名聚合 count/self_size(输出 tsv 供 cmp)
  cmp <base.tsv> <cur.tsv>                 对比两份 byname 结果, 输出 TOP 差异
  ids <file> <name> [type]                 提取指定 name(可选 type=native|object|closure) 的节点 id
  ret <file> <id> [maxDepth]               保留链: 从目标逆向 BFS 到 GC root(自动跳过 weak/WeakMap边)
  rettree <file> <id> [depth=8] [width=6]  保留树: 向上多叉展开所有非弱入边
  inedges <file> <id>                      列出目标的全部非弱入边(找引用者)
  dump <file> <id>                         打印目标节点全部出边(看属性/DOM子节点/detached状态)
  domparent <file> <id>                    全图扫描 element 边, 找目标的 DOM 父节点
  nodevtools <file> <id>                   排除 DevTools 节点后验证目标是否仍被 JS 强引用
  sandbox <file>                           wujie 沙箱注册表(idToSandboxMap)逐项审讯: 实例/options/销毁状态
  events <file>                            wujie EventBus(appEventObjMap)逐项审讯: key/事件数/异realm检测`;

// ---------- 载入与索引 ----------
export class Heap {
  constructor(file) {
    this.file = file;
    const snap = JSON.parse(fs.readFileSync(file, "utf8"));
    const meta = snap.snapshot.meta;
    this.nodes = snap.nodes;
    this.edges = snap.edges;
    this.strings = snap.strings;
    this.nodeCount = snap.snapshot.node_count;
    this.NF = meta.node_fields.length;
    this.F = {};
    meta.node_fields.forEach((f, i) => (this.F[f] = i));
    this.EF = meta.edge_fields.length;
    this.eF = {};
    meta.edge_fields.forEach((f, i) => (this.eF[f] = i));
    this.nodeTypeNames = Array.isArray(meta.node_types[0]) ? meta.node_types[0] : meta.node_types;
    this.edgeTypeNames = Array.isArray(meta.edge_types[0]) ? meta.edge_types[0] : meta.edge_types;
    // 每个节点第一条边的索引 + id -> index 映射
    this.firstEdge = new Float64Array(this.nodeCount);
    this.idxById = new Map();
    {
      let acc = 0;
      for (let i = 0; i < this.nodeCount; i++) {
        this.firstEdge[i] = acc;
        acc += this.nodes[i * this.NF + this.F.edge_count];
        this.idxById.set(this.nodes[i * this.NF + this.F.id], i);
      }
    }
  }
  info(i) {
    const b = i * this.NF;
    const raw = this.strings[this.nodes[b + this.F.name]] || "";
    return {
      type: this.nodeTypeNames[this.nodes[b + this.F.type]],
      name: raw,
      id: this.nodes[b + this.F.id],
      size: this.nodes[b + this.F.self_size],
      detached: this.F.detachedness != null ? this.nodes[b + this.F.detachedness] : 0,
      label: (raw.length > 100 ? raw.slice(0, 100) + "…" : raw) +
        `#${this.nodes[b + this.F.id]}(${this.nodeTypeNames[this.nodes[b + this.F.type]]}` +
        (this.F.detachedness != null && this.nodes[b + this.F.detachedness] ? ",detached" : "") + ")",
    };
  }
  idxOf(id) { return this.idxById.get(id) ?? -1; }
  /** 遍历节点 i 的所有边, 回调 (edgeIndex, edgeType, label, childIdx) */
  eachEdge(i, cb) {
    const fe = this.firstEdge[i], ec = this.nodes[i * this.NF + this.F.edge_count];
    for (let e = fe; e < fe + ec; e++) {
      const eb = e * this.EF;
      const t = this.edgeTypeNames[this.edges[eb + this.eF.type]];
      const rawLabel = t === "element" ? "[" + this.edges[eb + this.eF.name_or_index] + "]" : (this.strings[this.edges[eb + this.eF.name_or_index]] || "");
      const child = Math.floor(this.edges[eb + this.eF.to_node] / this.NF); // 关键: to_node 是绝对偏移
      cb(e, t, rawLabel, child);
    }
  }
  /** 是否构成强保留(weak 边与 WeakMap entry 边都不算) */
  isRetaining(t, label) {
    if (t === "weak") return false;
    if ((label || "").includes("pair in WeakMap")) return false;
    return true;
  }
  /** 反向邻接表: childIdx -> [[parentIdx, label, type], ...] (仅强边) */
  buildReverse() {
    const rev = new Map();
    for (let i = 0; i < this.nodeCount; i++) {
      this.eachEdge(i, (e, t, label, child) => {
        if (!this.isRetaining(t, label)) return;
        let list = rev.get(child);
        if (!list) rev.set(child, (list = []));
        list.push([i, label.length > 60 ? label.slice(0, 60) + "…" : label, t]);
      });
    }
    return rev;
  }
  /** 从所有 synthetic GC root 正向标记可达(仅强边, 可选黑名单) */
  markReachable(blocked = null) {
    const visited = new Uint8Array(this.nodeCount);
    const roots = [];
    for (let i = 0; i < this.nodeCount; i++) {
      if (this.nodeTypeNames[this.nodes[i * this.NF + this.F.type]] === "synthetic") roots.push(i);
    }
    roots.forEach((r) => (visited[r] = 1));
    const queue = [...roots];
    while (queue.length) {
      const cur = queue.pop();
      this.eachEdge(cur, (e, t, label, child) => {
        if (!this.isRetaining(t, label)) return;
        if (blocked && blocked.has(child)) return;
        if (visited[child]) return;
        visited[child] = 1;
        queue.push(child);
      });
    }
    return visited;
  }
}

// 仅作为 CLI 直接运行时执行主逻辑（被 import 时不执行）
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main();
}
function main() {
const [cmd, file, ...rest] = process.argv.slice(2);
if (!cmd || cmd === "help" || cmd === "--help") {
  console.log(HELP);
  process.exit(0);
}
// cmp 不需要快照文件
if (cmd !== "cmp" && !file) {
  console.error("缺少快照文件参数\n" + HELP);
  process.exit(1);
}
const heap = cmd !== "cmp" ? new Heap(file) : null;

switch (cmd) {
  case "meta": {
    console.log(JSON.stringify({
      node_fields: Object.keys(heap.F),
      edge_fields: Object.keys(heap.eF),
      node_types: heap.nodeTypeNames,
      edge_types: heap.edgeTypeNames,
      node_count: heap.nodeCount,
      has_detachedness: heap.F.detachedness != null,
    }, null, 2));
    break;
  }

  case "stats": {
    const visited = heap.markReachable();
    let reach = 0, detachedCount = 0, detachedSelf = 0;
    const byNameDetached = new Map();
    const watch = [
      ["ShadowRoot(native)", "ShadowRoot", "native"],
      ["ShadowRoot(closure)", "ShadowRoot", "closure"],
      ["HTMLIFrameElement(obj)", "HTMLIFrameElement", "object"],
      ["HTMLIFrameElement(native)", "HTMLIFrameElement", "native"],
      ["Window(native)", "Window", "native"],
      ["HTMLHtmlElement", "HTMLHtmlElement", "native"],
      ["HTMLDocument", "HTMLDocument", "native"],
      ["Document", "Document", "native"],
    ];
    const counts = new Map(watch.map(([k]) => [k, 0]));
    let totalSelf = 0;
    for (let i = 0; i < heap.nodeCount; i++) {
      totalSelf += heap.nodes[i * heap.NF + heap.F.self_size];
      if (visited[i]) reach++;
      const info = heap.info(i);
      if (info.detached === 1) {
        detachedCount++;
        detachedSelf += info.size;
        const cur = byNameDetached.get(info.name) || [0, 0];
        cur[0]++; cur[1] += info.size;
        byNameDetached.set(info.name, cur);
      }
      if (visited[i]) {
        for (const [k, n, t] of watch) {
          if (info.name === n && info.type === t) { counts.set(k, counts.get(k) + 1); break; }
        }
      }
    }
    const top = [...byNameDetached.entries()].sort((a, b) => b[1][0] - a[1][0]).slice(0, 15);
    console.log(`文件: ${file.split("/").pop()}`);
    console.log(`节点: ${heap.nodeCount.toLocaleString()}  可达: ${reach.toLocaleString()} (${(100 * reach / heap.nodeCount).toFixed(1)}%)  self_size合计: ${(totalSelf / 1048576).toFixed(1)}MB`);
    console.log(`detached 节点: ${detachedCount.toLocaleString()} (${(detachedSelf / 1048576).toFixed(1)}MB)`);
    console.log("关键类别(仅可达):");
    for (const [k, v] of counts) console.log(`  ${k}: ${v}`);
    console.log("detached TOP15(名字:数量(大小)):");
    for (const [k, v] of top) console.log(`  ${k}: ${v[0]}(${Math.round(v[1] / 1024)}KB)`);
    break;
  }

  case "wujie": {
    const visited = heap.markReachable();
    let patchedShells = 0, wujieEdges = 0, aliveSandboxes = 0;
    const srTypes = new Map();
    for (let i = 0; i < heap.nodeCount; i++) {
      if (!visited[i]) continue;
      const info = heap.info(i);
      if (info.name === "HTMLHtmlElement") {
        let has = false;
        heap.eachEdge(i, (e, t, label) => {
          if (t === "property" && label === "_hasPatch") has = true;
        });
        if (has) patchedShells++;
      }
      if (info.name === "ShadowRoot") {
        const k = info.type;
        srTypes.set(k, (srTypes.get(k) || 0) + 1);
      }
    }
    // __WUJIE / __WUJIE_INJECT 属性边
    for (let i = 0; i < heap.nodeCount; i++) {
      heap.eachEdge(i, (e, t, label) => {
        if (t === "property" && (label === "__WUJIE" || label === "$wujie")) wujieEdges++;
        if (t === "property" && label === "__WUJIE_INJECT") aliveSandboxes++;
      });
    }
    console.log(`文件: ${file.split("/").pop()}`);
    console.log(`wujie <html> 壳(_hasPatch, 可达): ${patchedShells}`);
    console.log(`__WUJIE/$wujie 属性边(总数): ${wujieEdges}`);
    console.log(`__WUJIE_INJECT 属性边(总数): ${aliveSandboxes}`);
    console.log(`ShadowRoot 按类型(可达): ${JSON.stringify([...srTypes])}`);
    break;
  }

  case "strings": {
    const needle = rest[0];
    if (!needle) { console.error("用法: strings <file> <needle>"); process.exit(1); }
    const hits = heap.strings.filter((s) => s.includes(needle));
    console.log(`"${needle}" 命中 ${hits.length} 条:`);
    hits.slice(0, 10).forEach((h) => console.log("  " + h.slice(0, 120)));
    break;
  }

  case "byname": {
    const out = rest[0];
    const m = new Map();
    for (let i = 0; i < heap.nodeCount; i++) {
      const b = i * heap.NF;
      const name = heap.strings[heap.nodes[b + heap.F.name]] || "<empty>";
      const cur = m.get(name) || [0, 0];
      cur[0]++;
      cur[1] += heap.nodes[b + heap.F.self_size];
      m.set(name, cur);
    }
    const lines = [...m.entries()].map(([k, v]) => `${k}\t${v[0]}\t${v[1]}`).join("\n");
    if (out) { fs.writeFileSync(out, lines); console.log(`已写入 ${out} (${m.size} 个名字)`); }
    else console.log(lines);
    break;
  }

  case "cmp": {
    const [base, cur] = [file, rest[0]];
    if (!base || !cur) { console.error("用法: cmp <base.tsv> <cur.tsv>"); process.exit(1); }
    const load = (f) => {
      const m = new Map();
      for (const line of fs.readFileSync(f, "utf8").split("\n")) {
        if (!line) continue;
        const [name, count, size] = line.split("\t");
        m.set(name, [parseInt(count), parseInt(size)]);
      }
      return m;
    };
    const a = load(base), b = load(cur);
    const rows = [];
    for (const [name, [c1, s1]] of a) {
      const v2 = b.get(name);
      if (!v2) rows.push({ name, dc: -c1, ds: -s1 });
      else if (v2[0] !== c1 || v2[1] !== s1) rows.push({ name, dc: v2[0] - c1, ds: v2[1] - s1 });
    }
    for (const [name, [c2, s2]] of b) if (!a.has(name)) rows.push({ name, dc: c2, ds: s2 });
    console.log("=== 按数量差 TOP30 (正=对比快照更多) ===");
    [...rows].sort((x, y) => Math.abs(y.dc) - Math.abs(x.dc)).slice(0, 30)
      .forEach((r) => console.log(`${r.name}\t${r.dc > 0 ? "+" : ""}${r.dc}\t${Math.round(r.ds / 1024)}KB`));
    console.log("\n=== 按 self_size 差 TOP30 ===");
    [...rows].sort((x, y) => Math.abs(y.ds) - Math.abs(x.ds)).slice(0, 30)
      .forEach((r) => console.log(`${r.name}\t${r.dc > 0 ? "+" : ""}${r.dc}\t${Math.round(r.ds / 1024)}KB`));
    break;
  }

  case "ids": {
    const name = rest[0];
    const type = rest[1]; // 可选
    if (!name) { console.error("用法: ids <file> <name> [type]"); process.exit(1); }
    for (let i = 0; i < heap.nodeCount; i++) {
      const info = heap.info(i);
      if (info.name === name && (!type || info.type === type)) console.log(info.id);
    }
    break;
  }

  case "ret": {
    const id = parseInt(rest[0], 10);
    const maxDepth = parseInt(rest[1] || "60", 10);
    const target = heap.idxOf(id);
    if (target < 0) { console.error(`id ${id} 未找到`); process.exit(1); }
    const rev = heap.buildReverse();
    // BFS 找最短路径到 synthetic root
    const prev = new Map([[target, null]]);
    const queue = [target];
    let root = null;
    while (queue.length) {
      const cur = queue.shift();
      if (heap.info(cur).type === "synthetic") { root = cur; break; }
      for (const [p, label, t] of rev.get(cur) || []) {
        if (!prev.has(p)) { prev.set(p, [cur, label, t]); queue.push(p); }
      }
    }
    const path = [];
    let cur = root;
    let depth = 0;
    while (cur !== undefined && cur !== null && depth < maxDepth) {
      const info = heap.info(cur);
      const rec = prev.get(cur);
      if (rec) { path.push(`${info.label}  <-[${rec[1]}|${rec[2]}]-`); cur = rec[0]; }
      else { path.push(`${info.label}  <GC ROOT>`); break; }
      depth++;
    }
    const t = heap.info(target);
    console.log(`目标: ${t.label} self=${t.size}`);
    console.log(path.join("\n"));
    break;
  }

  case "rettree": {
    const id = parseInt(rest[0], 10);
    const maxDepth = parseInt(rest[1] || "8", 10);
    const maxWidth = parseInt(rest[2] || "6", 10);
    const target = heap.idxOf(id);
    if (target < 0) { console.error(`id ${id} 未找到`); process.exit(1); }
    const rev = heap.buildReverse();
    const out = [`ROOT ${heap.info(target).label}`];
    const seen = new Set([target]);
    (function walk(idx, depth, prefix) {
      const parents = (rev.get(idx) || []).slice(0, maxWidth);
      parents.forEach(([p, label, t], k) => {
        const pi = heap.info(p);
        const last = k === parents.length - 1;
        out.push(`${prefix}${last ? "└─" : "├─"}[${label}|${t}] ${pi.label}`);
        if (pi.type !== "synthetic" && depth + 1 < maxDepth && !seen.has(p)) {
          seen.add(p);
          walk(p, depth + 1, prefix + (last ? "  " : "│ "));
        }
      });
    })(target, 0, "");
    console.log(out.join("\n"));
    break;
  }

  case "inedges": {
    const id = parseInt(rest[0], 10);
    const target = heap.idxOf(id);
    if (target < 0) { console.error(`id ${id} 未找到`); process.exit(1); }
    const rev = heap.buildReverse();
    console.log(`目标 ${heap.info(target).label} 的非弱入边:`);
    for (const [p, label, t] of rev.get(target) || []) {
      console.log(`  <-[${label}|${t}]- ${heap.info(p).label}`);
    }
    break;
  }

  case "dump": {
    const id = parseInt(rest[0], 10);
    const target = heap.idxOf(id);
    if (target < 0) { console.error(`id ${id} 未找到`); process.exit(1); }
    const info = heap.info(target);
    // detached: 1=已脱离文档树(detached DOM); 0=仍 attached。
    // iframe detached=0 但无 JS 入边 => destroy 未摘除 DOM, 必然泄漏整个 realm
    const extra = info.detached === 1 ? " [detached=已脱离文档]" : info.detached === 0 ? " [detached=0 仍attached]" : "";
    console.log(`节点: ${info.label} self=${info.size}${extra}`);
    heap.eachEdge(target, (e, t, label, child) => {
      console.log(`  [${label}|${t}] -> ${heap.info(child).label}`);
    });
    break;
  }

  case "domparent": {
    const id = parseInt(rest[0], 10);
    const targets = new Set();
    for (let i = 0; i < heap.nodeCount; i++) if (heap.nodes[i * heap.NF + heap.F.id] === id) targets.add(i);
    if (!targets.size) { console.error(`id ${id} 未找到`); process.exit(1); }
    console.log(`目标: ${heap.info([...targets][0]).label}`);
    let found = 0;
    for (let i = 0; i < heap.nodeCount && found < 10; i++) {
      heap.eachEdge(i, (e, t, label, child) => {
        if (t === "element" && targets.has(child)) {
          console.log(`  DOM父: ${heap.info(i).label} --${label}-->`);
          found++;
        }
      });
    }
    if (!found) console.log("  (无 element 入边 — 不是任何节点的 DOM 子节点)");
    break;
  }

  case "nodevtools": {
    const id = parseInt(rest[0], 10);
    const target = heap.idxOf(id);
    if (target < 0) { console.error(`id ${id} 未找到`); process.exit(1); }
    // DevTools 黑名单
    const blocked = new Set();
    for (let i = 0; i < heap.nodeCount; i++) {
      const name = heap.strings[heap.nodes[i * heap.NF + heap.F.name]] || "";
      if (name.includes("InspectorDOMAgent") || name.includes("v8_inspector")) blocked.add(i);
    }
    console.log(`DevTools 黑名单节点: ${blocked.size}`);
    // 正向可达(带父指针回溯)
    const visited = new Uint32Array(heap.nodeCount);
    const prevLabel = new Map();
    const roots = [];
    for (let i = 0; i < heap.nodeCount; i++) {
      if (heap.nodeTypeNames[heap.nodes[i * heap.NF + heap.F.type]] === "synthetic") roots.push(i);
    }
    roots.forEach((r) => (visited[r] = 0xffffffff));
    const queue = [...roots];
    while (queue.length) {
      const cur = queue.shift();
      heap.eachEdge(cur, (e, t, label, child) => {
        if (!heap.isRetaining(t, label)) return;
        if (blocked.has(child) || visited[child]) return;
        visited[child] = cur + 1;
        prevLabel.set(child, `${label}|${t}`);
        queue.push(child);
      });
    }
    if (!visited[target]) {
      console.log(`>>> ${heap.info(target).label} 排除 DevTools 后【不可达】=> 纯 DevTools 快照伪影`);
      break;
    }
    const path = [];
    let cur = target, depth = 0;
    while (depth < 80) {
      path.push(`${heap.info(cur).label}  <--[${prevLabel.get(cur)}]`);
      if (visited[cur] === 0xffffffff) break; // 已到 GC root
      cur = visited[cur] - 1;
      depth++;
    }
    path.push("<GC ROOT(非DevTools)>");
    console.log(`>>> 仍可达! 真实 JS 锚点保留链:`);
    console.log(path.join("\n"));
    break;
  }

  // ---------- wujie 内部注册表审讯 ----------
  // 共享: 定位 __WUJIE_INJECT 下的指定属性(返回目标节点索引)
  case "sandbox":
  case "events": {
    const prop = cmd === "sandbox" ? "idToSandboxMap" : "appEventObjMap";
    let mapNode = null;
    for (let i = 0; i < heap.nodeCount && mapNode === null; i++) {
      heap.eachEdge(i, (e, t, label, child) => {
        if (label === "__WUJIE_INJECT" && mapNode === null) {
          heap.eachEdge(child, (e2, t2, l2, c2) => { if (l2 === prop) mapNode = c2; });
        }
      });
    }
    if (mapNode === null) { console.error(`未找到 __WUJIE_INJECT.${prop}(快照中无活跃 wujie?)`); process.exit(1); }
    // V8 OrderedHashMap: table 数组的 internal 索引边 [n] = header + [key, value] 交替
    let table = null;
    heap.eachEdge(mapNode, (e, t, label, child) => { if (label === "table") table = child; });
    const elems = [];
    if (table !== null) {
      heap.eachEdge(table, (e, t, label, child) => {
        const m = /^(\d+)$/.exec(label);
        if (m) elems.push([+m[1], child]);
      });
    }
    elems.sort((a, b) => a[0] - b[0]);
    const fmt = (v) => {
      if (v === undefined || v === null) return "∅";
      const inf = heap.info(v);
      return inf.type === "string" ? JSON.stringify(inf.name) : `${inf.label}`;
    };

    if (cmd === "sandbox") {
      console.log(`== wujie 沙箱注册表 idToSandboxMap ==`);
      console.log(`entry 总数: ${elems.length / 2 | 0}\n`);
      const fields = ["id", "url", "destroyed", "mountFlag", "hrefFlag", "alive", "activeFlag", "execFlag", "preload", "degrade", "fiber", "lifecycles", "iframe", "shadowRoot", "el", "bus", "plugins", "proxy"];
      for (let j = 0; j < elems.length - 1; j++) {
        const kInf = heap.info(elems[j][1]);
        if (kInf.type !== "string") continue;
        const v = elems[j + 1][1];
        console.log(`===== 沙箱 ${kInf.name} =====`);
        // 包装形态判断: {wujie, options}(改造版缓存) / 沙箱实例本体 / 纯 options 残留
        let hasWujie = false, hasOptions = false;
        heap.eachEdge(v, (e, t, label) => {
          if (label === "wujie") hasWujie = true;
          if (label === "options") hasOptions = true;
        });
        if (hasWujie || hasOptions) {
          console.log(`  形态: {wujie:${hasWujie ? "✓" : "✗"}, options:${hasOptions ? "✓" : "✗"}}` +
            (hasOptions && !hasWujie ? "  ← 沙箱已销毁, options 残留(次要泄漏: 钉住 lifeCycles 闭包)" : "  ← 沙箱实例存活"));
          // options 内层再探一层
          heap.eachEdge(v, (e, t, label, child) => {
            if (label === "options") {
              heap.eachEdge(child, (e2, t2, l2, c2) => {
                if (["name", "url", "alive"].includes(l2)) console.log(`    options.${l2} =`, fmt(c2));
              });
            }
          });
        } else {
          for (const f of fields) {
            let hit = null;
            heap.eachEdge(v, (e, t, label, child) => { if (label === f) hit = child; });
            console.log(`  ${f} =`, fmt(hit));
          }
        }
        console.log("");
        j++; // 跳过 value
      }
    } else {
      console.log(`== wujie EventBus 注册表 appEventObjMap ==`);
      console.log(`entry 总数: ${elems.length / 2 | 0}\n`);
      for (let j = 0; j < elems.length - 1; j++) {
        const kInf = heap.info(elems[j][1]);
        if (kInf.type !== "string") continue;
        const v = elems[j + 1][1];
        const keyIsTimestamp = /^\d{12,}$/.test(kInf.name);
        // 事件统计 + 异 realm 检测
        const events = [];
        let foreignRealm = false;
        heap.eachEdge(v, (e, t, label, child) => {
          if (t !== "property" || label === "__proto__") return;
          let n = 0;
          heap.eachEdge(child, (e2, t2, l2, c2) => { if (t2 === "element" || /^\d+$/.test(l2)) n++; });
          events.push(`${label}(${n})`);
        });
        heap.eachEdge(v, (e, t, label, child) => {
          if (label === "__proto__") {
            // 主 realm 对象的 proto label 带 URL 标注; 异 realm(已死 iframe)创建的对象无标注
            if (!/\//.test(heap.info(child).label)) foreignRealm = true;
          }
        });
        const flags = [
          keyIsTimestamp ? "时间戳key(模块级bus=new EventBus(Date.now()),非沙箱bus)" : null,
          events.length === 0 ? "空entry(无任何回调,疑似跨realm泄漏锚点)" : null,
          foreignRealm ? "⚠异realm对象(hidden class钉死创建realm,销毁后整个子应用无法GC)" : null,
        ].filter(Boolean);
        console.log(`entry ${kInf.name}`);
        console.log(`  事件: ${events.length ? events.join(", ") : "(空)"}`);
        if (flags.length) flags.forEach((f) => console.log(`  ${f.startsWith("⚠") ? f : "· " + f}`));
        console.log("");
        j++;
      }
    }
    break;
  }

  default:
    console.error(`未知命令: ${cmd}\n` + HELP);
    process.exit(1);
}
} // end main
