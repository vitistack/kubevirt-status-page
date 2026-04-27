(function() {
    "use strict";

    const canvas = document.getElementById("topology-canvas");
    const ctx = canvas.getContext("2d");
    let currentData = null;
    let vmHitRegions = []; // for tooltip hit-testing

    function resize() {
        const dpr = window.devicePixelRatio || 1;
        const cssW = canvas.parentElement.clientWidth;
        const cssH = canvas.parentElement.clientHeight;
        canvas.style.width = cssW + "px";
        canvas.style.height = cssH + "px";
        canvas.width = cssW * dpr;
        canvas.height = cssH * dpr;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        if (currentData) draw(currentData);
    }
    window.addEventListener("resize", resize);
    resize();

    // --- Tooltip ---
    const tooltip = document.createElement("div");
    tooltip.className = "topology-tooltip";
    document.body.appendChild(tooltip);

    canvas.addEventListener("mousemove", (e) => {
        const rect = canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const hit = vmHitRegions.find(r => mx >= r.x && mx <= r.x + r.w && my >= r.y && my <= r.y + r.h);
        if (hit) {
            tooltip.style.display = "block";
            tooltip.style.left = (e.clientX + 12) + "px";
            tooltip.style.top = (e.clientY + 12) + "px";
            tooltip.innerHTML = `<strong>${escapeHtml(hit.vm.name)}</strong><br>` +
                `<span class="t-status">${escapeHtml(hit.vm.status)}</span> · ` +
                `${hit.vm.cpuCores} vCPU · ${(hit.vm.memoryMB/1024).toFixed(0)} GB` +
                (hit.vm.namespace ? `<br><small>${escapeHtml(hit.vm.namespace)}</small>` : "");
            canvas.style.cursor = "pointer";
        } else {
            tooltip.style.display = "none";
            canvas.style.cursor = "default";
        }
    });
    canvas.addEventListener("mouseleave", () => { tooltip.style.display = "none"; });

    function escapeHtml(s) {
        const d = document.createElement("div");
        d.appendChild(document.createTextNode(s || ""));
        return d.innerHTML;
    }

    // --- Data fetching ---
    fetch("/api/status")
        .then(r => r.json())
        .then(data => { currentData = data; draw(data); })
        .catch(err => console.error("Initial fetch failed:", err));

    function connectSSE() {
        const es = new EventSource("/events");
        const badge = document.getElementById("connection-status");

        es.onopen = () => {
            badge.textContent = "Live";
            badge.className = "connection-badge connected";
        };

        es.onmessage = (e) => {
            try {
                const data = JSON.parse(e.data);
                currentData = data;
                document.getElementById("updated").textContent = "Updated: " + new Date(data.updated).toLocaleTimeString();
                draw(data);
            } catch (err) {
                console.error("SSE parse error:", err);
            }
        };

        es.onerror = () => {
            badge.textContent = "Disconnected";
            badge.className = "connection-badge disconnected";
            es.close();
            setTimeout(connectSSE, 3000);
        };
    }
    connectSSE();

    // --- Color helpers ---
    function statusColor(status) {
        if (!status) return "#64748b";
        const s = status.toLowerCase();
        if (s === "running") return "#22c55e";
        if (s.includes("error") || s.includes("unschedulable")) return "#ef4444";
        if (s === "scheduling" || s === "pending") return "#eab308";
        return "#64748b";
    }

    function isOK(status) {
        return status === "Running";
    }

    function nodeColor(status) {
        return status === "Ready" ? "#3b82f6" : "#ef4444";
    }

    // --- Drawing ---
    function draw(data) {
        const nodes = data.nodes || [];
        const W = canvas.parentElement.clientWidth;
        const H = canvas.parentElement.clientHeight;

        ctx.clearRect(0, 0, W, H);
        vmHitRegions = [];

        if (nodes.length === 0) {
            ctx.fillStyle = "#64748b";
            ctx.font = "16px sans-serif";
            ctx.textAlign = "center";
            ctx.fillText("No nodes found", W / 2, H / 2);
            return;
        }

        // Collect unscheduled VMs from clusters
        const onNodeKeys = new Set();
        nodes.forEach(n => (n.vms || []).forEach(vm => onNodeKeys.add(vm.namespace + "/" + vm.name)));
        const unscheduled = [];
        (data.clusters || []).forEach(cluster => {
            (cluster.vms || []).forEach(vm => {
                const k = vm.namespace + "/" + vm.name;
                if (!onNodeKeys.has(k) && !vm.nodeName) {
                    unscheduled.push(vm);
                    onNodeKeys.add(k);
                }
            });
        });

        const padding = 14;
        const legendH = 24;
        const unschedH = unscheduled.length > 0 ? 44 : 0;

        const nodeBoxW = 220;
        const nodeBoxH = 64;
        const availH = H - padding * 2 - legendH - unschedH;

        // Left column: distribute node boxes evenly to fill the full height
        const nodeStep = nodes.length > 1
            ? (availH - nodeBoxH) / (nodes.length - 1)
            : 0;
        const nodesStartY = padding;

        // Right area: VM cloud
        const cloudX = padding + nodeBoxW + 90; // gap for connector curves
        const cloudY = padding;
        const cloudW = W - cloudX - padding;
        const cloudH = availH;

        // Compute global resource scale for dot sizing
        const allVMs = [];
        nodes.forEach(n => (n.vms || []).forEach(v => allVMs.push(v)));
        const vmScores = allVMs.map(v => vmScore(v));
        const minScore = vmScores.length ? Math.min(...vmScores) : 1;
        const maxScore = vmScores.length ? Math.max(...vmScores) : 1;

        // Pick a uniform slot size that lets ALL VMs fit (across all node clusters)
        const slot = pickSlotSize(allVMs.length, cloudW, cloudH);

        // Per-node cluster placement: each node gets its own region whose vertical
        // center aligns with the node's vertical center. This makes connectors
        // short, parallel, and easy to follow.
        const placements = [];
        const clusterMeta = []; // {node, cx, cy, w, h}

        nodes.forEach((n, i) => {
            const ny = nodesStartY + i * nodeStep;
            const nodeMidY = ny + nodeBoxH / 2;
            const vms = n.vms || [];
            if (vms.length === 0) {
                clusterMeta.push({ node: n, cx: cloudX + 40, cy: nodeMidY, w: 0, h: 0 });
                return;
            }
            // Choose number of columns so cluster is roughly square-ish
            const cols = Math.max(1, Math.min(
                Math.floor(cloudW / slot),
                Math.ceil(Math.sqrt(vms.length * 1.4))
            ));
            const rows = Math.ceil(vms.length / cols);
            const rowStep = slot * 0.866;
            const clusterW = cols * slot + slot / 2; // include hex offset
            const clusterH = (rows - 1) * rowStep + slot;

            // Available band for this node: between adjacent nodes' midpoints
            const prevMid = i === 0 ? padding : (nodesStartY + (i - 1) * nodeStep + nodeBoxH / 2);
            const nextMid = i === nodes.length - 1 ? (padding + availH) : (nodesStartY + (i + 1) * nodeStep + nodeBoxH / 2);
            const bandTop = (prevMid + nodeMidY) / 2;
            const bandBot = (nextMid + nodeMidY) / 2;

            // Center cluster vertically on node's midY, but clamp inside band
            let clusterTop = nodeMidY - clusterH / 2;
            if (clusterTop < bandTop + 2) clusterTop = bandTop + 2;
            if (clusterTop + clusterH > bandBot - 2) clusterTop = bandBot - 2 - clusterH;
            // Final clamp inside cloud
            if (clusterTop < cloudY) clusterTop = cloudY;
            if (clusterTop + clusterH > cloudY + cloudH) clusterTop = cloudY + cloudH - clusterH;

            const clusterLeft = cloudX;
            const clusterRight = clusterLeft + clusterW;
            clusterMeta.push({
                node: n,
                cx: clusterLeft + clusterW / 2,
                cy: clusterTop + clusterH / 2,
                left: clusterLeft,
                right: clusterRight,
                top: clusterTop,
                bot: clusterTop + clusterH
            });

            // Sort: problems first (drawn at edges), then by score desc
            const sortedVMs = vms.slice().sort((a, b) => {
                const aOK = isOK(a.status), bOK = isOK(b.status);
                if (aOK !== bOK) return aOK ? 1 : -1;
                return vmScore(b) - vmScore(a);
            });

            for (let k = 0; k < sortedVMs.length; k++) {
                const row = Math.floor(k / cols);
                const col = k % cols;
                const rowOff = (row % 2 === 1) ? slot / 2 : 0;
                const dx = clusterLeft + slot / 2 + col * slot + rowOff;
                const dy = clusterTop + slot / 2 + row * rowStep;
                const vm = sortedVMs[k];
                placements.push({
                    vm: vm,
                    x: dx,
                    y: dy,
                    r: radiusForSlot(vmScore(vm), slot, minScore, maxScore),
                    slot: slot,
                    nodeIdx: i
                });
            }
        });

        // Draw connectors FIRST (behind boxes & dots) — one bundle per node
        nodes.forEach((n, i) => {
            const ny = nodesStartY + i * nodeStep;
            const nodeRightX = padding + nodeBoxW;
            const nodeMidY = ny + nodeBoxH / 2;
            const cm = clusterMeta[i];
            const places = placements.filter(p => p.nodeIdx === i);
            const nodeStrokeColor = nodeColor(n.status);
            drawClusterConnector(nodeRightX, nodeMidY, cm, places, nodeStrokeColor);
        });

        // Draw node boxes
        nodes.forEach((n, i) => {
            const ny = nodesStartY + i * nodeStep;
            drawNodeBox(n, padding, ny, nodeBoxW, nodeBoxH);
        });

        // Draw VM dots on top
        placements.forEach(p => drawVMDot(p));

        // Unscheduled VMs strip
        if (unscheduled.length > 0) {
            const usY = padding + availH + 4;
            drawUnscheduled(unscheduled, padding, usY, W - padding * 2, unschedH - 8);
        }

        drawLegend(padding, H - legendH + 4, W - padding * 2);
    }

    // Score = vCPU + memoryGB (rough resource weight)
    function vmScore(vm) {
        return (vm.cpuCores || 0) + (vm.memoryMB || 0) / 1024;
    }

    // Pick slot size large enough that totalVMs fit in cloudW x cloudH (hex packed)
    function pickSlotSize(totalVMs, w, h) {
        for (let s = 30; s >= 6; s -= 0.5) {
            const cols = Math.max(1, Math.floor(w / s));
            const rowStep = s * 0.866;
            const rows = Math.max(1, Math.floor(h / rowStep));
            if (cols * rows >= totalVMs) return s;
        }
        return 6;
    }

    function radiusForSlot(score, slot, minScore, maxScore) {
        const maxR = slot * 0.46;
        const minR = Math.max(2, slot * 0.22);
        if (maxScore <= minScore) return (minR + maxR) / 2;
        const t = (score - minScore) / (maxScore - minScore);
        return minR + (maxR - minR) * Math.sqrt(t);
    }

    // Draw a clean "ribbon" connector from node to its cluster:
    // a single thick translucent band + thin lines from cluster's left edge to each dot.
    function drawClusterConnector(srcX, srcY, cm, places, color) {
        if (!cm || !places.length) return;

        // Bundle waypoint: at the cluster's left edge, vertically at cluster center
        const bundleX = cm.left - 8;
        const bundleY = cm.cy;

        // 1. Soft "ribbon" — wide bezier from node to bundle, fades into cluster
        const ribbonW = Math.max(6, Math.min(28, places.length * 0.6));
        ctx.strokeStyle = color;
        ctx.globalAlpha = 0.10;
        ctx.lineWidth = ribbonW;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(srcX, srcY);
        const cp1x = srcX + (bundleX - srcX) * 0.55;
        const cp2x = srcX + (bundleX - srcX) * 0.45;
        ctx.bezierCurveTo(cp1x, srcY, cp2x, bundleY, bundleX, bundleY);
        ctx.stroke();

        // 2. Thin guide line on top of ribbon
        ctx.globalAlpha = 0.55;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(srcX, srcY);
        ctx.bezierCurveTo(cp1x, srcY, cp2x, bundleY, bundleX, bundleY);
        ctx.stroke();

        // 3. Short fan-out from bundle to each dot — short straight-ish lines
        ctx.globalAlpha = 0.22;
        ctx.lineWidth = 0.6;
        for (const p of places) {
            ctx.beginPath();
            ctx.moveTo(bundleX, bundleY);
            // Quadratic curve so fan looks soft
            const midX = (bundleX + p.x) / 2;
            ctx.quadraticCurveTo(midX, bundleY, p.x, p.y);
            ctx.stroke();
        }

        ctx.globalAlpha = 1;
        ctx.lineCap = "butt";
    }

    function drawVMDot(p) {
        const vm = p.vm;
        const ok = isOK(vm.status);
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fillStyle = ok ? "#22c55e" : statusColor(vm.status);
        ctx.fill();
        ctx.strokeStyle = ok ? "#064e3b" : "#1e293b";
        ctx.lineWidth = ok ? 0.8 : 1.2;
        ctx.stroke();
        if (!ok) {
            // Add an outer ring for visibility
            ctx.beginPath();
            ctx.arc(p.x, p.y, p.r + 2, 0, Math.PI * 2);
            ctx.strokeStyle = statusColor(vm.status);
            ctx.globalAlpha = 0.5;
            ctx.lineWidth = 1;
            ctx.stroke();
            ctx.globalAlpha = 1;
        }
        vmHitRegions.push({ x: p.x - p.r, y: p.y - p.r, w: p.r * 2, h: p.r * 2, vm: vm });
    }

    function drawNodeBox(n, x, y, w, h) {
        // Card with subtle gradient
        const grad = ctx.createLinearGradient(x, y, x, y + h);
        grad.addColorStop(0, "#1e293b");
        grad.addColorStop(1, "#0f172a");
        ctx.fillStyle = grad;
        ctx.strokeStyle = nodeColor(n.status);
        ctx.lineWidth = 1.5;
        roundRect(ctx, x, y, w, h, 8);
        ctx.fill();
        ctx.stroke();

        // Status pill in top-left
        ctx.beginPath();
        ctx.arc(x + 12, y + 14, 4, 0, Math.PI * 2);
        ctx.fillStyle = n.status === "Ready" ? "#22c55e" : "#ef4444";
        ctx.fill();

        // Name
        ctx.fillStyle = "#f1f5f9";
        ctx.font = "bold 12px -apple-system, sans-serif";
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillText(n.name, x + 22, y + 14);

        // VM count + issues badge in top-right
        const cnt = (n.vms || []).length;
        const errCnt = (n.vms || []).filter(v => !isOK(v.status)).length;
        ctx.fillStyle = "#94a3b8";
        ctx.font = "10px -apple-system, sans-serif";
        ctx.textAlign = "right";
        ctx.textBaseline = "middle";
        ctx.fillText(cnt + " VM" + (cnt === 1 ? "" : "s"), x + w - 10, y + 14);

        // CPU/MEM bars
        const vmCPU = (n.vms || []).reduce((s, v) => s + v.cpuCores, 0);
        const cpuLimit = n.cpuAllocatable || n.cpuCapacity || 1;
        const cpuPct = Math.min(vmCPU / cpuLimit, 1);
        const vmMem = (n.vms || []).reduce((s, v) => s + v.memoryMB, 0);
        const memLimit = n.memAllocMB || n.memoryCapMB || 1;
        const memPct = Math.min(vmMem / memLimit, 1);

        const bx = x + 12;
        const bw = w - 24;
        const bh = 4;
        const cpuY = y + 32;
        const memY = y + 50;

        // CPU label + bar
        ctx.fillStyle = "#64748b";
        ctx.font = "9px -apple-system, sans-serif";
        ctx.textAlign = "left";
        ctx.textBaseline = "alphabetic";
        ctx.fillText("CPU", bx, cpuY - 1);
        ctx.textAlign = "right";
        ctx.fillStyle = "#cbd5e1";
        ctx.fillText(vmCPU + " / " + cpuLimit, bx + bw, cpuY - 1);
        roundRect(ctx, bx, cpuY + 2, bw, bh, 2);
        ctx.fillStyle = "#1e293b"; ctx.fill();
        if (cpuPct > 0) {
            roundRect(ctx, bx, cpuY + 2, Math.max(2, bw * cpuPct), bh, 2);
            ctx.fillStyle = cpuPct < 0.6 ? "#22c55e" : cpuPct < 0.85 ? "#eab308" : "#ef4444"; ctx.fill();
        }

        // MEM label + bar
        ctx.fillStyle = "#64748b";
        ctx.font = "9px -apple-system, sans-serif";
        ctx.textAlign = "left";
        ctx.fillText("MEM", bx, memY - 1);
        ctx.textAlign = "right";
        ctx.fillStyle = "#cbd5e1";
        ctx.fillText((vmMem/1024).toFixed(0) + " / " + (memLimit/1024).toFixed(0) + " GB", bx + bw, memY - 1);
        roundRect(ctx, bx, memY + 2, bw, bh, 2);
        ctx.fillStyle = "#1e293b"; ctx.fill();
        if (memPct > 0) {
            roundRect(ctx, bx, memY + 2, Math.max(2, bw * memPct), bh, 2);
            ctx.fillStyle = memPct < 0.6 ? "#22c55e" : memPct < 0.85 ? "#eab308" : "#ef4444"; ctx.fill();
        }

        // Error badge if any
        if (errCnt > 0) {
            ctx.fillStyle = "#ef4444";
            ctx.beginPath();
            ctx.arc(x + w - 10, y + h - 10, 5, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = "#fff";
            ctx.font = "bold 8px -apple-system, sans-serif";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(String(errCnt), x + w - 10, y + h - 10);
        }
    }

    function drawUnscheduled(vms, x, y, w, h) {
        ctx.fillStyle = "#64748b";
        ctx.font = "bold 10px -apple-system, sans-serif";
        ctx.textAlign = "left";
        ctx.textBaseline = "top";
        ctx.fillText("Unscheduled (" + vms.length + ")", x, y);

        const dotR = 5;
        const dotSpace = 14;
        const dotsPerRow = Math.max(1, Math.floor(w / dotSpace));
        const startX = x;
        const startY = y + 18;
        for (let i = 0; i < Math.min(vms.length, dotsPerRow); i++) {
            const dx = startX + i * dotSpace + dotR;
            const dy = startY;
            ctx.beginPath();
            ctx.arc(dx, dy, dotR, 0, Math.PI * 2);
            ctx.fillStyle = statusColor(vms[i].status);
            ctx.fill();
            vmHitRegions.push({ x: dx - dotR, y: dy - dotR, w: dotR * 2, h: dotR * 2, vm: vms[i] });
        }
        if (vms.length > dotsPerRow) {
            ctx.fillStyle = "#94a3b8";
            ctx.font = "9px -apple-system, sans-serif";
            ctx.textBaseline = "middle";
            ctx.fillText("+" + (vms.length - dotsPerRow), startX + dotsPerRow * dotSpace + 2, startY);
        }
    }

    function drawLegend(x, y, w) {
        ctx.font = "10px -apple-system, sans-serif";
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        const items = [
            { color: "#22c55e", label: "Running" },
            { color: "#ef4444", label: "Error" },
            { color: "#eab308", label: "Pending" },
            { color: "#64748b", label: "Unknown" }
        ];
        let lx = x;
        items.forEach(item => {
            ctx.beginPath();
            ctx.arc(lx + 5, y + 10, 4, 0, Math.PI * 2);
            ctx.fillStyle = item.color;
            ctx.fill();
            ctx.fillStyle = "#94a3b8";
            ctx.fillText(item.label, lx + 14, y + 10);
            lx += ctx.measureText(item.label).width + 30;
        });
        // Hint
        ctx.textAlign = "right";
        ctx.fillStyle = "#475569";
        ctx.fillText("Hover any VM for details", x + w, y + 10);
    }

    function shortName(name) {
        const parts = name.split("-");
        if (parts.length <= 2) return name;
        return parts.slice(-2).join("-");
    }

    function roundRect(ctx, x, y, w, h, r) {
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.lineTo(x + w - r, y);
        ctx.quadraticCurveTo(x + w, y, x + w, y + r);
        ctx.lineTo(x + w, y + h - r);
        ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
        ctx.lineTo(x + r, y + h);
        ctx.quadraticCurveTo(x, y + h, x, y + h - r);
        ctx.lineTo(x, y + r);
        ctx.quadraticCurveTo(x, y, x + r, y);
        ctx.closePath();
    }
})();
