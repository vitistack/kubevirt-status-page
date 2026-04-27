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

        const padding = 16;
        const legendH = 28;
        const unschedH = unscheduled.length > 0 ? 50 : 0;

        const nodeBoxW = 180;
        const rowGap = 6;
        const availH = H - padding * 2 - legendH - unschedH;
        const rowH = Math.max(46, Math.floor((availH - (nodes.length - 1) * rowGap) / nodes.length));

        // Draw each node row
        nodes.forEach((n, i) => {
            const y = padding + i * (rowH + rowGap);
            drawNodeRow(n, padding, y, nodeBoxW, rowH, W - padding * 2);
        });

        // Unscheduled VMs strip
        if (unscheduled.length > 0) {
            const usY = padding + nodes.length * (rowH + rowGap);
            drawUnscheduled(unscheduled, padding, usY, W - padding * 2, unschedH - 8);
        }

        drawLegend(padding, H - legendH + 4, W - padding * 2);
    }

    function drawNodeRow(n, x, y, nodeW, rowH, totalW) {
        // Node box (left)
        ctx.fillStyle = "#1e293b";
        ctx.strokeStyle = nodeColor(n.status);
        ctx.lineWidth = 1.5;
        roundRect(ctx, x, y, nodeW, rowH, 6);
        ctx.fill();
        ctx.stroke();

        // Status dot
        ctx.beginPath();
        ctx.arc(x + 12, y + 12, 4, 0, Math.PI * 2);
        ctx.fillStyle = n.status === "Ready" ? "#22c55e" : "#ef4444";
        ctx.fill();

        // Name
        ctx.fillStyle = "#f1f5f9";
        ctx.font = "bold 11px -apple-system, sans-serif";
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillText(n.name, x + 22, y + 12);

        // CPU/MEM bars
        const vmCPU = (n.vms || []).reduce((s, v) => s + v.cpuCores, 0);
        const cpuLimit = n.cpuAllocatable || n.cpuCapacity || 1;
        const cpuPct = Math.min(vmCPU / cpuLimit, 1);
        const vmMem = (n.vms || []).reduce((s, v) => s + v.memoryMB, 0);
        const memLimit = n.memAllocMB || n.memoryCapMB || 1;
        const memPct = Math.min(vmMem / memLimit, 1);

        const bx = x + 8;
        const bw = nodeW - 16;
        const bh = 4;
        const cpuY = y + rowH - 26;
        const memY = y + rowH - 12;

        // CPU
        ctx.fillStyle = "#94a3b8";
        ctx.font = "8px -apple-system, sans-serif";
        ctx.textBaseline = "bottom";
        ctx.textAlign = "left";
        ctx.fillText("CPU", bx, cpuY - 1);
        ctx.textAlign = "right";
        ctx.fillText(vmCPU + "/" + cpuLimit, bx + bw, cpuY - 1);
        roundRect(ctx, bx, cpuY, bw, bh, 2);
        ctx.fillStyle = "#334155"; ctx.fill();
        if (cpuPct > 0) {
            roundRect(ctx, bx, cpuY, Math.max(2, bw * cpuPct), bh, 2);
            ctx.fillStyle = cpuPct < 0.5 ? "#22c55e" : cpuPct < 0.8 ? "#eab308" : "#ef4444"; ctx.fill();
        }
        // MEM
        ctx.fillStyle = "#94a3b8";
        ctx.font = "8px -apple-system, sans-serif";
        ctx.textBaseline = "bottom";
        ctx.textAlign = "left";
        ctx.fillText("MEM", bx, memY - 1);
        ctx.textAlign = "right";
        ctx.fillText((vmMem/1024).toFixed(0) + "/" + (memLimit/1024).toFixed(0) + "G", bx + bw, memY - 1);
        roundRect(ctx, bx, memY, bw, bh, 2);
        ctx.fillStyle = "#334155"; ctx.fill();
        if (memPct > 0) {
            roundRect(ctx, bx, memY, Math.max(2, bw * memPct), bh, 2);
            ctx.fillStyle = memPct < 0.5 ? "#22c55e" : memPct < 0.8 ? "#eab308" : "#ef4444"; ctx.fill();
        }

        // VMs area (right)
        const vmsX = x + nodeW + 12;
        const vmsW = totalW - nodeW - 12;
        const vmsY = y + 4;
        const vmsH = rowH - 8;

        // Connector line from node to VMs area
        ctx.strokeStyle = "#334155";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x + nodeW, y + rowH / 2);
        ctx.lineTo(vmsX - 2, y + rowH / 2);
        ctx.stroke();

        drawVMs(n.vms || [], vmsX, vmsY, vmsW, vmsH);

        // VM count
        const cnt = (n.vms || []).length;
        const errCnt = (n.vms || []).filter(v => !isOK(v.status)).length;
        ctx.fillStyle = "#64748b";
        ctx.font = "9px -apple-system, sans-serif";
        ctx.textAlign = "right";
        ctx.textBaseline = "top";
        const cntText = cnt + " VMs" + (errCnt > 0 ? " · " + errCnt + " issue" : "");
        ctx.fillText(cntText, x + totalW, y + 2);
    }

    function drawVMs(vms, x, y, w, h) {
        if (vms.length === 0) {
            ctx.fillStyle = "#475569";
            ctx.font = "italic 10px -apple-system, sans-serif";
            ctx.textAlign = "left";
            ctx.textBaseline = "middle";
            ctx.fillText("(no VMs)", x + 4, y + h / 2);
            return;
        }

        // Separate OK from problem VMs
        const ok = vms.filter(v => isOK(v.status));
        const bad = vms.filter(v => !isOK(v.status));

        // Layout problem VMs first as labeled pills, then OK VMs as dots
        let cx = x;
        const cy = y + h / 2;

        // Problem VM pills
        ctx.font = "10px 'SF Mono', monospace";
        bad.forEach(vm => {
            const label = shortName(vm.name);
            const tw = ctx.measureText(label).width;
            const pillW = tw + 18;
            const pillH = Math.min(20, h - 4);
            if (cx + pillW > x + w) return; // skip if overflow
            ctx.fillStyle = "#1e293b";
            ctx.strokeStyle = statusColor(vm.status);
            ctx.lineWidth = 1.5;
            roundRect(ctx, cx, cy - pillH / 2, pillW, pillH, 4);
            ctx.fill();
            ctx.stroke();
            // dot
            ctx.beginPath();
            ctx.arc(cx + 6, cy, 3, 0, Math.PI * 2);
            ctx.fillStyle = statusColor(vm.status);
            ctx.fill();
            // label
            ctx.fillStyle = "#e2e8f0";
            ctx.textAlign = "left";
            ctx.textBaseline = "middle";
            ctx.fillText(label, cx + 13, cy);

            vmHitRegions.push({ x: cx, y: cy - pillH / 2, w: pillW, h: pillH, vm: vm });
            cx += pillW + 4;
        });

        // OK VMs as dots — pack densely
        const dotR = 5;
        const dotSpace = 14;
        const dotsPerRow = Math.max(1, Math.floor((x + w - cx) / dotSpace));
        const dotRows = Math.min(Math.ceil(ok.length / dotsPerRow), Math.max(1, Math.floor(h / dotSpace)));
        const dotsCapacity = dotsPerRow * dotRows;

        const startY = cy - ((dotRows - 1) * dotSpace) / 2;
        for (let i = 0; i < Math.min(ok.length, dotsCapacity); i++) {
            const r = Math.floor(i / dotsPerRow);
            const c = i % dotsPerRow;
            const dx = cx + c * dotSpace + dotR;
            const dy = startY + r * dotSpace;
            ctx.beginPath();
            ctx.arc(dx, dy, dotR, 0, Math.PI * 2);
            ctx.fillStyle = "#22c55e";
            ctx.fill();
            ctx.strokeStyle = "#064e3b";
            ctx.lineWidth = 1;
            ctx.stroke();

            vmHitRegions.push({ x: dx - dotR, y: dy - dotR, w: dotR * 2, h: dotR * 2, vm: ok[i] });
        }

        // Overflow indicator
        if (ok.length > dotsCapacity) {
            const remaining = ok.length - dotsCapacity;
            ctx.fillStyle = "#94a3b8";
            ctx.font = "9px -apple-system, sans-serif";
            ctx.textAlign = "left";
            ctx.textBaseline = "middle";
            ctx.fillText("+" + remaining, cx + dotsPerRow * dotSpace + 2, cy);
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
