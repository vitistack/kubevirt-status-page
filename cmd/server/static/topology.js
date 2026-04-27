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

        const padding = 12;
        const legendH = 24;
        const unschedH = unscheduled.length > 0 ? 44 : 0;

        const nodeBoxW = 200;
        const rowGap = 4;
        const availH = H - padding * 2 - legendH - unschedH;
        const rowH = Math.max(38, Math.floor((availH - (nodes.length - 1) * rowGap) / nodes.length));

        // Compute global VM resource scale across all nodes for dot sizing
        const allVMs = [];
        nodes.forEach(n => (n.vms || []).forEach(v => allVMs.push(v)));
        const vmScores = allVMs.map(v => vmScore(v));
        const minScore = vmScores.length ? Math.min(...vmScores) : 1;
        const maxScore = vmScores.length ? Math.max(...vmScores) : 1;

        // Draw each node row
        nodes.forEach((n, i) => {
            const y = padding + i * (rowH + rowGap);
            drawNodeRow(n, padding, y, nodeBoxW, rowH, W - padding * 2, minScore, maxScore);
        });

        // Unscheduled VMs strip
        if (unscheduled.length > 0) {
            const usY = padding + nodes.length * (rowH + rowGap);
            drawUnscheduled(unscheduled, padding, usY, W - padding * 2, unschedH - 8);
        }

        drawLegend(padding, H - legendH + 4, W - padding * 2);
    }

    function drawNodeRow(n, x, y, nodeW, rowH, totalW, minScore, maxScore) {
        // Node box (left) — compact horizontal layout
        ctx.fillStyle = "#1e293b";
        ctx.strokeStyle = nodeColor(n.status);
        ctx.lineWidth = 1.5;
        roundRect(ctx, x, y, nodeW, rowH, 5);
        ctx.fill();
        ctx.stroke();

        // Status dot
        ctx.beginPath();
        ctx.arc(x + 10, y + rowH / 2, 4, 0, Math.PI * 2);
        ctx.fillStyle = n.status === "Ready" ? "#22c55e" : "#ef4444";
        ctx.fill();

        // Name (top line) + bars (bottom line) all in compact box
        ctx.fillStyle = "#f1f5f9";
        ctx.font = "bold 11px -apple-system, sans-serif";
        ctx.textAlign = "left";
        ctx.textBaseline = "top";
        ctx.fillText(n.name, x + 20, y + 5);

        // CPU/MEM as a single combined mini bar group at bottom
        const vmCPU = (n.vms || []).reduce((s, v) => s + v.cpuCores, 0);
        const cpuLimit = n.cpuAllocatable || n.cpuCapacity || 1;
        const cpuPct = Math.min(vmCPU / cpuLimit, 1);
        const vmMem = (n.vms || []).reduce((s, v) => s + v.memoryMB, 0);
        const memLimit = n.memAllocMB || n.memoryCapMB || 1;
        const memPct = Math.min(vmMem / memLimit, 1);

        const bx = x + 20;
        const bw = nodeW - 28;
        const bh = 3;
        const cpuY = y + rowH - 14;
        const memY = y + rowH - 6;

        // CPU bar (no label, just thin bar with pct text inline)
        roundRect(ctx, bx, cpuY, bw, bh, 1.5);
        ctx.fillStyle = "#334155"; ctx.fill();
        if (cpuPct > 0) {
            roundRect(ctx, bx, cpuY, Math.max(2, bw * cpuPct), bh, 1.5);
            ctx.fillStyle = cpuPct < 0.5 ? "#22c55e" : cpuPct < 0.8 ? "#eab308" : "#ef4444"; ctx.fill();
        }
        // MEM bar
        roundRect(ctx, bx, memY, bw, bh, 1.5);
        ctx.fillStyle = "#334155"; ctx.fill();
        if (memPct > 0) {
            roundRect(ctx, bx, memY, Math.max(2, bw * memPct), bh, 1.5);
            ctx.fillStyle = memPct < 0.5 ? "#22c55e" : memPct < 0.8 ? "#eab308" : "#ef4444"; ctx.fill();
        }

        // Compact stats text on right side of node box
        ctx.fillStyle = "#94a3b8";
        ctx.font = "9px -apple-system, sans-serif";
        ctx.textAlign = "right";
        ctx.textBaseline = "top";
        ctx.fillText(vmCPU + "c · " + (vmMem/1024).toFixed(0) + "G", x + nodeW - 6, y + 5);

        // VMs area (right)
        const vmsX = x + nodeW + 10;
        const vmsW = totalW - nodeW - 10;
        const vmsY = y + 2;
        const vmsH = rowH - 4;

        // Connector line
        ctx.strokeStyle = "#334155";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x + nodeW, y + rowH / 2);
        ctx.lineTo(vmsX - 2, y + rowH / 2);
        ctx.stroke();

        drawVMs(n.vms || [], vmsX, vmsY, vmsW, vmsH, minScore, maxScore);

        // VM count on far right (above VMs)
        const cnt = (n.vms || []).length;
        const errCnt = (n.vms || []).filter(v => !isOK(v.status)).length;
        ctx.fillStyle = "#64748b";
        ctx.font = "9px -apple-system, sans-serif";
        ctx.textAlign = "right";
        ctx.textBaseline = "top";
        const cntText = cnt + " VMs" + (errCnt > 0 ? " · " + errCnt + " issue" : "");
        ctx.fillText(cntText, x + totalW, y + 1);
    }

    // Score = vCPU + memoryGB (rough resource weight)
    function vmScore(vm) {
        return (vm.cpuCores || 0) + (vm.memoryMB || 0) / 1024;
    }

    function dotRadius(score, minScore, maxScore) {
        const minR = 3;
        const maxR = 11;
        if (maxScore <= minScore) return (minR + maxR) / 2;
        const t = (score - minScore) / (maxScore - minScore);
        // sqrt scale so area grows linearly with resource
        return minR + (maxR - minR) * Math.sqrt(t);
    }

    function drawVMs(vms, x, y, w, h, minScore, maxScore) {
        if (vms.length === 0) {
            ctx.fillStyle = "#475569";
            ctx.font = "italic 10px -apple-system, sans-serif";
            ctx.textAlign = "left";
            ctx.textBaseline = "middle";
            ctx.fillText("(no VMs)", x + 4, y + h / 2);
            return;
        }

        // Sort: problem VMs first (so they get rendered as visible pills), then OK by score (largest first)
        const sorted = vms.slice().sort((a, b) => {
            const aOK = isOK(a.status), bOK = isOK(b.status);
            if (aOK !== bOK) return aOK ? 1 : -1;
            return vmScore(b) - vmScore(a);
        });

        let cx = x;
        const cy = y + h / 2;

        // Problem VMs as labeled pills
        const bad = sorted.filter(v => !isOK(v.status));
        ctx.font = "10px 'SF Mono', monospace";
        for (const vm of bad) {
            const label = shortName(vm.name);
            const tw = ctx.measureText(label).width;
            const pillW = tw + 18;
            const pillH = Math.min(18, h - 2);
            if (cx + pillW > x + w) break;
            ctx.fillStyle = "#1e293b";
            ctx.strokeStyle = statusColor(vm.status);
            ctx.lineWidth = 1.5;
            roundRect(ctx, cx, cy - pillH / 2, pillW, pillH, 4);
            ctx.fill();
            ctx.stroke();
            ctx.beginPath();
            ctx.arc(cx + 6, cy, 3, 0, Math.PI * 2);
            ctx.fillStyle = statusColor(vm.status);
            ctx.fill();
            ctx.fillStyle = "#e2e8f0";
            ctx.textAlign = "left";
            ctx.textBaseline = "middle";
            ctx.fillText(label, cx + 13, cy);
            vmHitRegions.push({ x: cx, y: cy - pillH / 2, w: pillW, h: pillH, vm: vm });
            cx += pillW + 4;
        }

        // OK VMs as scaled dots in a cloud-like scatter
        const ok = sorted.filter(v => isOK(v.status));

        // Cloud area: from current cx to right edge, full height
        const cloudX = cx;
        const cloudY = y;
        const cloudW = Math.max(20, x + w - cx - 14);
        const cloudH = h;

        // Compute radii first
        const dots = ok.map(vm => ({
            vm: vm,
            r: dotRadius(vmScore(vm), minScore, maxScore)
        }));

        // Place dots using a deterministic jittered grid: walk left-to-right,
        // pick a column slot and randomly offset within the row's height
        // Use a seeded RNG so layout is stable per render
        const seed = (cx * 31 + ok.length * 7) | 0;
        const rng = mulberry32(seed >>> 0);

        // Keep already-placed dots; for each new dot, try jittered candidates
        // until non-overlapping or fall back to grid sweep
        const placed = [];
        let cursorX = cloudX + 6;
        let drawn = 0;

        for (const d of dots) {
            const r = d.r;
            const minSep = 1;
            let bestX = -1, bestY = -1;
            // Try a handful of jittered candidates near the cursor
            for (let tries = 0; tries < 14; tries++) {
                const jitterY = (rng() - 0.5) * (cloudH - r * 2);
                const jitterX = rng() * 18; // small forward jitter
                const cxCand = cursorX + jitterX;
                const cyCand = cloudY + cloudH / 2 + jitterY;
                if (cxCand + r > cloudX + cloudW) break;
                // Check no overlap with last few placed
                let ok2 = true;
                for (let i = placed.length - 1; i >= Math.max(0, placed.length - 40); i--) {
                    const p = placed[i];
                    const dx = p.x - cxCand;
                    const dy = p.y - cyCand;
                    if (dx * dx + dy * dy < (p.r + r + minSep) * (p.r + r + minSep)) {
                        ok2 = false; break;
                    }
                }
                if (ok2) { bestX = cxCand; bestY = cyCand; break; }
            }

            // Fallback: sweep right until it fits
            if (bestX < 0) {
                let sweepX = cursorX + 4;
                while (sweepX + r <= cloudX + cloudW) {
                    const cyCand = cloudY + cloudH / 2 + (rng() - 0.5) * (cloudH - r * 2);
                    let ok2 = true;
                    for (let i = placed.length - 1; i >= Math.max(0, placed.length - 40); i--) {
                        const p = placed[i];
                        const dx = p.x - sweepX;
                        const dy = p.y - cyCand;
                        if (dx * dx + dy * dy < (p.r + r + minSep) * (p.r + r + minSep)) {
                            ok2 = false; break;
                        }
                    }
                    if (ok2) { bestX = sweepX; bestY = cyCand; break; }
                    sweepX += 2;
                }
            }

            if (bestX < 0) break; // no more room

            // Draw
            ctx.beginPath();
            ctx.arc(bestX, bestY, r, 0, Math.PI * 2);
            ctx.fillStyle = "#22c55e";
            ctx.globalAlpha = 0.92;
            ctx.fill();
            ctx.globalAlpha = 1;
            ctx.strokeStyle = "#064e3b";
            ctx.lineWidth = 1;
            ctx.stroke();
            vmHitRegions.push({ x: bestX - r, y: bestY - r, w: r * 2, h: r * 2, vm: d.vm });
            placed.push({ x: bestX, y: bestY, r: r });
            drawn++;
            // Slowly advance cursor based on radii so the cloud spreads rightwards
            cursorX = Math.max(cursorX, bestX - r * 1.5);
            cursorX += r * 0.4;
        }

        if (drawn < ok.length) {
            const remaining = ok.length - drawn;
            ctx.fillStyle = "#94a3b8";
            ctx.font = "9px -apple-system, sans-serif";
            ctx.textAlign = "left";
            ctx.textBaseline = "middle";
            ctx.fillText("+" + remaining, cloudX + cloudW + 2, cy);
        }
    }

    // Seeded PRNG (Mulberry32) for stable layouts
    function mulberry32(a) {
        return function() {
            a |= 0; a = a + 0x6D2B79F5 | 0;
            let t = a;
            t = Math.imul(t ^ t >>> 15, t | 1);
            t ^= t + Math.imul(t ^ t >>> 7, t | 61);
            return ((t ^ t >>> 14) >>> 0) / 4294967296;
        };
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
