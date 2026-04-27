(function() {
    "use strict";

    const canvas = document.getElementById("topology-canvas");
    const ctx = canvas.getContext("2d");
    let currentData = null;

    function resize() {
        canvas.width = canvas.parentElement.clientWidth;
        canvas.height = canvas.parentElement.clientHeight;
        if (currentData) draw(currentData);
    }
    window.addEventListener("resize", resize);
    resize();

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

    function nodeColor(status) {
        return status === "Ready" ? "#3b82f6" : "#ef4444";
    }

    // --- Drawing ---
    function draw(data) {
        const nodes = data.nodes || [];
        const W = canvas.width;
        const H = canvas.height;

        ctx.clearRect(0, 0, W, H);

        if (nodes.length === 0) {
            ctx.fillStyle = "#64748b";
            ctx.font = "16px sans-serif";
            ctx.textAlign = "center";
            ctx.fillText("No nodes found", W / 2, H / 2);
            return;
        }

        // Collect all VMs (including unscheduled from clusters)
        const allVMs = [];
        const vmSet = new Set();

        // VMs assigned to nodes
        nodes.forEach(node => {
            (node.vms || []).forEach(vm => {
                if (!vmSet.has(vm.namespace + "/" + vm.name)) {
                    vmSet.add(vm.namespace + "/" + vm.name);
                    allVMs.push(vm);
                }
            });
        });

        // VMs from clusters that might not be on any node
        (data.clusters || []).forEach(cluster => {
            (cluster.vms || []).forEach(vm => {
                if (!vmSet.has(vm.namespace + "/" + vm.name)) {
                    vmSet.add(vm.namespace + "/" + vm.name);
                    allVMs.push(vm);
                }
            });
        });

        // Sort VMs by host node (matching node order), then by name within each node
        // Unassigned VMs go at the end
        const nodeOrder = {};
        nodes.forEach((n, i) => { nodeOrder[n.name] = i; });
        allVMs.sort((a, b) => {
            const aIdx = a.nodeName && nodeOrder[a.nodeName] !== undefined ? nodeOrder[a.nodeName] : 999;
            const bIdx = b.nodeName && nodeOrder[b.nodeName] !== undefined ? nodeOrder[b.nodeName] : 999;
            if (aIdx !== bIdx) return aIdx - bIdx;
            return a.name.localeCompare(b.name);
        });

        // Layout: nodes on left, VMs on right
        const nodeBoxW = 220;
        const nodeBoxH = 85;
        const vmBoxW = 220;
        const vmBoxH = 40;
        const padding = 40;

        const nodeX = padding + nodeBoxW / 2;
        const vmX = W - padding - vmBoxW / 2;

        const nodeSpacing = Math.min(130, (H - padding * 2) / Math.max(nodes.length, 1));
        const vmSpacing = Math.min(55, (H - padding * 2) / Math.max(allVMs.length, 1));

        const nodeTotalH = nodes.length * nodeSpacing;
        const vmTotalH = allVMs.length * vmSpacing;

        const nodeStartY = Math.max(padding, (H - nodeTotalH) / 2);
        const vmStartY = Math.max(padding, (H - vmTotalH) / 2);

        // Compute positions
        const nodePositions = nodes.map((n, i) => ({
            x: nodeX,
            y: nodeStartY + i * nodeSpacing + nodeSpacing / 2,
            node: n
        }));

        const vmPositions = allVMs.map((vm, i) => ({
            x: vmX,
            y: vmStartY + i * vmSpacing + vmSpacing / 2,
            vm: vm
        }));

        // Build node name -> position lookup
        const nodePosMap = {};
        nodePositions.forEach(np => { nodePosMap[np.node.name] = np; });

        // Draw connections first (behind boxes)
        vmPositions.forEach(vp => {
            const vm = vp.vm;
            if (vm.nodeName && nodePosMap[vm.nodeName]) {
                const np = nodePosMap[vm.nodeName];
                const x1 = np.x + nodeBoxW / 2;
                const y1 = np.y;
                const x2 = vp.x - vmBoxW / 2;
                const y2 = vp.y;

                // Bezier curve
                const cpx = (x1 + x2) / 2;
                ctx.beginPath();
                ctx.moveTo(x1, y1);
                ctx.bezierCurveTo(cpx, y1, cpx, y2, x2, y2);
                ctx.strokeStyle = statusColor(vm.status);
                ctx.globalAlpha = 0.4;
                ctx.lineWidth = 2;
                ctx.stroke();
                ctx.globalAlpha = 1;
            }
        });

        // Draw node boxes
        nodePositions.forEach(np => {
            const n = np.node;
            const x = np.x - nodeBoxW / 2;
            const y = np.y - nodeBoxH / 2;

            // Box
            ctx.fillStyle = "#1e293b";
            ctx.strokeStyle = nodeColor(n.status);
            ctx.lineWidth = 2;
            roundRect(ctx, x, y, nodeBoxW, nodeBoxH, 8);
            ctx.fill();
            ctx.stroke();

            // Status dot + Name
            ctx.beginPath();
            ctx.arc(x + 16, y + 16, 5, 0, Math.PI * 2);
            ctx.fillStyle = n.status === "Ready" ? "#22c55e" : "#ef4444";
            ctx.fill();

            ctx.fillStyle = "#f1f5f9";
            ctx.font = "bold 12px -apple-system, sans-serif";
            ctx.textAlign = "left";
            ctx.textBaseline = "middle";
            ctx.fillText(n.name, x + 28, y + 16);

            // Mini CPU bar
            const vmCPU = (n.vms || []).reduce((s, v) => s + v.cpuCores, 0);
            const cpuLimit = n.cpuAllocatable || n.cpuCapacity || 1;
            const cpuPct = Math.min(vmCPU / cpuLimit, 1);

            const barX = x + 12;
            const barW = nodeBoxW - 24;
            const barH = 7;
            const cpuBarY = y + 38;

            ctx.fillStyle = "#cbd5e1";
            ctx.font = "bold 9px -apple-system, sans-serif";
            ctx.textBaseline = "bottom";
            ctx.fillText("CPU", barX, cpuBarY - 2);
            ctx.fillStyle = "#94a3b8";
            ctx.font = "9px -apple-system, sans-serif";
            ctx.textAlign = "right";
            ctx.fillText(vmCPU + " / " + cpuLimit + " cores", barX + barW, cpuBarY - 2);
            ctx.textAlign = "left";

            // Bar background
            roundRect(ctx, barX, cpuBarY, barW, barH, 3);
            ctx.fillStyle = "#334155";
            ctx.fill();
            // Bar fill
            if (cpuPct > 0) {
                const fillW = Math.max(4, barW * cpuPct);
                roundRect(ctx, barX, cpuBarY, fillW, barH, 3);
                ctx.fillStyle = cpuPct < 0.5 ? "#22c55e" : cpuPct < 0.8 ? "#eab308" : "#ef4444";
                ctx.fill();
            }

            // Mini Memory bar
            const vmMem = (n.vms || []).reduce((s, v) => s + v.memoryMB, 0);
            const memLimit = n.memAllocMB || n.memoryCapMB || 1;
            const memPct = Math.min(vmMem / memLimit, 1);
            const memBarY = cpuBarY + 22;

            ctx.fillStyle = "#cbd5e1";
            ctx.font = "bold 9px -apple-system, sans-serif";
            ctx.textBaseline = "bottom";
            ctx.fillText("MEM", barX, memBarY - 2);
            ctx.fillStyle = "#94a3b8";
            ctx.font = "9px -apple-system, sans-serif";
            ctx.textAlign = "right";
            ctx.fillText((vmMem / 1024).toFixed(0) + " / " + (memLimit / 1024).toFixed(0) + " GB", barX + barW, memBarY - 2);
            ctx.textAlign = "left";

            // Bar background
            roundRect(ctx, barX, memBarY, barW, barH, 3);
            ctx.fillStyle = "#334155";
            ctx.fill();
            // Bar fill
            if (memPct > 0) {
                const fillW = Math.max(4, barW * memPct);
                roundRect(ctx, barX, memBarY, fillW, barH, 3);
                ctx.fillStyle = memPct < 0.5 ? "#22c55e" : memPct < 0.8 ? "#eab308" : "#ef4444";
                ctx.fill();
            }
        });

        // Draw VM boxes
        vmPositions.forEach(vp => {
            const vm = vp.vm;
            const x = vp.x - vmBoxW / 2;
            const y = vp.y - vmBoxH / 2;

            // Box
            ctx.fillStyle = "#1e293b";
            ctx.strokeStyle = statusColor(vm.status);
            ctx.lineWidth = 1.5;
            roundRect(ctx, x, y, vmBoxW, vmBoxH, 6);
            ctx.fill();
            ctx.stroke();

            // Status dot
            ctx.beginPath();
            ctx.arc(x + 12, vp.y - 4, 4, 0, Math.PI * 2);
            ctx.fillStyle = statusColor(vm.status);
            ctx.fill();

            // Name
            ctx.fillStyle = "#e2e8f0";
            ctx.font = "11px 'SF Mono', SFMono-Regular, monospace";
            ctx.textAlign = "left";
            ctx.textBaseline = "middle";
            const displayName = vm.name.length > 28 ? vm.name.slice(-28) : vm.name;
            ctx.fillText(displayName, x + 22, vp.y - 4);

            // Details
            ctx.fillStyle = "#64748b";
            ctx.font = "9px -apple-system, sans-serif";
            ctx.fillText(vm.status + " · " + vm.cpuCores + " vCPU · " + (vm.memoryMB / 1024).toFixed(0) + " GB", x + 22, vp.y + 10);
        });

        // Legend
        ctx.font = "11px -apple-system, sans-serif";
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";

        const legendY = H - 20;
        const items = [
            { color: "#22c55e", label: "Running" },
            { color: "#ef4444", label: "Error" },
            { color: "#eab308", label: "Pending" },
            { color: "#64748b", label: "Unknown" }
        ];
        let lx = padding;
        items.forEach(item => {
            ctx.beginPath();
            ctx.arc(lx + 5, legendY, 4, 0, Math.PI * 2);
            ctx.fillStyle = item.color;
            ctx.fill();
            ctx.fillStyle = "#94a3b8";
            ctx.fillText(item.label, lx + 14, legendY);
            lx += ctx.measureText(item.label).width + 30;
        });
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
