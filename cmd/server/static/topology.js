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
    function clusterColor(cluster) {
        const vms = cluster.vms || [];
        if (vms.length === 0) return "#64748b";
        const errors = vms.filter(v => v.status && (v.status.toLowerCase().includes("error") || v.status.toLowerCase().includes("unschedulable")));
        if (errors.length > 0) return "#ef4444";
        const allRunning = vms.every(v => v.status === "Running");
        if (allRunning) return "#22c55e";
        return "#eab308";
    }

    function nodeColor(status) {
        return status === "Ready" ? "#3b82f6" : "#ef4444";
    }

    // --- Drawing ---
    function draw(data) {
        const W = canvas.width;
        const H = canvas.height;
        ctx.clearRect(0, 0, W, H);

        // Support both hub (data.datacenters) and agent (data.nodes/clusters) mode
        if (data.datacenters) {
            drawHub(data.datacenters, W, H);
        } else {
            drawSingleDC(data.nodes || [], data.clusters || [], W, H);
        }
    }

    function drawSingleDC(nodes, clusters, W, H) {
        if (clusters.length === 0 && nodes.length === 0) {
            ctx.fillStyle = "#64748b";
            ctx.font = "16px sans-serif";
            ctx.textAlign = "center";
            ctx.fillText("No data", W / 2, H / 2);
            return;
        }

        const padding = 40;
        const clusterBoxW = 200;
        const clusterBoxH = 70;
        const nodeBoxW = 220;
        const nodeBoxH = 85;

        const clusterX = padding + clusterBoxW / 2;
        const nodeX = W - padding - nodeBoxW / 2;

        const clusterSpacing = Math.min(100, (H - padding * 2) / Math.max(clusters.length, 1));
        const nodeSpacing = Math.min(120, (H - padding * 2) / Math.max(nodes.length, 1));

        const clusterTotalH = clusters.length * clusterSpacing;
        const nodeTotalH = nodes.length * nodeSpacing;

        const clusterStartY = Math.max(padding, (H - clusterTotalH) / 2);
        const nodeStartY = Math.max(padding, (H - nodeTotalH) / 2);

        const clusterPositions = clusters.map((c, i) => ({
            x: clusterX, y: clusterStartY + i * clusterSpacing + clusterSpacing / 2, cluster: c
        }));
        const nodePositions = nodes.map((n, i) => ({
            x: nodeX, y: nodeStartY + i * nodeSpacing + nodeSpacing / 2, node: n
        }));

        const nodePosMap = {};
        nodePositions.forEach(np => { nodePosMap[np.node.name] = np; });

        // Draw connections: cluster → nodes
        clusterPositions.forEach(cp => {
            const c = cp.cluster;
            (c.nodes || []).forEach(nodeName => {
                if (nodePosMap[nodeName]) {
                    const np = nodePosMap[nodeName];
                    drawBezier(cp.x + clusterBoxW / 2, cp.y, np.x - nodeBoxW / 2, np.y, clusterColor(c), 0.35);
                }
            });
        });

        // Draw cluster boxes
        clusterPositions.forEach(cp => drawClusterBox(cp, clusterBoxW, clusterBoxH));

        // Draw node boxes
        nodePositions.forEach(np => drawNodeBox(np, nodeBoxW, nodeBoxH));

        // Legend
        drawLegend(padding, H);
    }

    function drawHub(datacenters, W, H) {
        // Each datacenter gets a horizontal band with its own cluster→node topology
        const padding = 30;
        const dcCount = datacenters.length;
        if (dcCount === 0) {
            ctx.fillStyle = "#64748b";
            ctx.font = "16px sans-serif";
            ctx.textAlign = "center";
            ctx.fillText("No datacenters reporting", W / 2, H / 2);
            return;
        }

        const bandGap = 16;
        const bandH = (H - padding * 2 - bandGap * (dcCount - 1)) / dcCount;

        datacenters.forEach((dc, i) => {
            const bandY = padding + i * (bandH + bandGap);
            const dcName = dc.datacenter || "unknown";
            const nodes = dc.nodes || [];
            const clusters = dc.clusters || [];

            // DC separator line & label
            if (i > 0) {
                ctx.strokeStyle = "#334155";
                ctx.lineWidth = 1;
                ctx.setLineDash([4, 4]);
                ctx.beginPath();
                ctx.moveTo(padding, bandY - bandGap / 2);
                ctx.lineTo(W - padding, bandY - bandGap / 2);
                ctx.stroke();
                ctx.setLineDash([]);
            }

            // DC name label
            ctx.fillStyle = dc.stale ? "#ef4444" : "#38bdf8";
            ctx.font = "bold 13px -apple-system, sans-serif";
            ctx.textAlign = "left";
            ctx.textBaseline = "top";
            ctx.fillText(dcName + (dc.stale ? " (STALE)" : ""), padding, bandY + 2);

            const innerTop = bandY + 22;
            const innerH = bandH - 26;

            const clusterBoxW = 190;
            const clusterBoxH = 60;
            const nodeBoxW = 210;
            const nodeBoxH = 75;

            const clusterX = padding + clusterBoxW / 2 + 10;
            const nodeX = W - padding - nodeBoxW / 2 - 10;

            const clusterSpacing = Math.min(80, innerH / Math.max(clusters.length, 1));
            const nodeSpacing = Math.min(95, innerH / Math.max(nodes.length, 1));

            const clusterTotalH = clusters.length * clusterSpacing;
            const nodeTotalH = nodes.length * nodeSpacing;

            const clusterStartY = innerTop + Math.max(0, (innerH - clusterTotalH) / 2);
            const nodeStartY = innerTop + Math.max(0, (innerH - nodeTotalH) / 2);

            const clusterPositions = clusters.map((c, ci) => ({
                x: clusterX, y: clusterStartY + ci * clusterSpacing + clusterSpacing / 2, cluster: c
            }));
            const nodePositions = nodes.map((n, ni) => ({
                x: nodeX, y: nodeStartY + ni * nodeSpacing + nodeSpacing / 2, node: n
            }));

            const nodePosMap = {};
            nodePositions.forEach(np => { nodePosMap[np.node.name] = np; });

            // Draw connections
            clusterPositions.forEach(cp => {
                (cp.cluster.nodes || []).forEach(nodeName => {
                    if (nodePosMap[nodeName]) {
                        const np = nodePosMap[nodeName];
                        drawBezier(cp.x + clusterBoxW / 2, cp.y, np.x - nodeBoxW / 2, np.y, clusterColor(cp.cluster), 0.3);
                    }
                });
            });

            // Draw cluster boxes
            clusterPositions.forEach(cp => drawClusterBox(cp, clusterBoxW, clusterBoxH));

            // Draw node boxes
            nodePositions.forEach(np => drawNodeBox(np, nodeBoxW, nodeBoxH));
        });

        drawLegend(padding, H);
    }

    // --- Shared drawing helpers ---

    function drawBezier(x1, y1, x2, y2, color, alpha) {
        const cpx = (x1 + x2) / 2;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.bezierCurveTo(cpx, y1, cpx, y2, x2, y2);
        ctx.strokeStyle = color;
        ctx.globalAlpha = alpha;
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.globalAlpha = 1;
    }

    function drawClusterBox(cp, boxW, boxH) {
        const c = cp.cluster;
        const x = cp.x - boxW / 2;
        const y = cp.y - boxH / 2;
        const color = clusterColor(c);

        // Box
        ctx.fillStyle = "#1e293b";
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        roundRect(ctx, x, y, boxW, boxH, 8);
        ctx.fill();
        ctx.stroke();

        // Cluster icon + name
        ctx.fillStyle = "#38bdf8";
        ctx.font = "bold 12px -apple-system, sans-serif";
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        const displayName = c.name.length > 22 ? c.name.slice(0, 22) + "…" : c.name;
        ctx.fillText("⎈ " + displayName, x + 10, y + 16);

        // VM summary
        const total = (c.vms || []).length;
        const running = (c.vms || []).filter(v => v.status === "Running").length;
        const totalCPU = (c.vms || []).reduce((s, v) => s + v.cpuCores, 0);
        const totalMem = (c.vms || []).reduce((s, v) => s + v.memoryMB, 0);

        ctx.fillStyle = running === total ? "#6ee7b7" : "#fcd34d";
        ctx.font = "11px -apple-system, sans-serif";
        ctx.fillText(running + "/" + total + " VMs running", x + 10, y + 34);

        ctx.fillStyle = "#94a3b8";
        ctx.font = "10px -apple-system, sans-serif";
        ctx.fillText(totalCPU + " vCPU · " + (totalMem / 1024).toFixed(0) + " GB · " + (c.nodes || []).length + " nodes", x + 10, y + 50);
    }

    function drawNodeBox(np, boxW, boxH) {
        const n = np.node;
        const x = np.x - boxW / 2;
        const y = np.y - boxH / 2;

        // Box
        ctx.fillStyle = "#1e293b";
        ctx.strokeStyle = nodeColor(n.status);
        ctx.lineWidth = 2;
        roundRect(ctx, x, y, boxW, boxH, 8);
        ctx.fill();
        ctx.stroke();

        // Status dot + Name
        ctx.beginPath();
        ctx.arc(x + 14, y + 14, 5, 0, Math.PI * 2);
        ctx.fillStyle = n.status === "Ready" ? "#22c55e" : "#ef4444";
        ctx.fill();

        ctx.fillStyle = "#f1f5f9";
        ctx.font = "bold 12px -apple-system, sans-serif";
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillText(n.name, x + 26, y + 14);

        // VM count
        const vmCount = (n.vms || []).length;
        ctx.fillStyle = "#94a3b8";
        ctx.font = "10px -apple-system, sans-serif";
        ctx.textAlign = "right";
        ctx.fillText(vmCount + " VMs", x + boxW - 10, y + 14);
        ctx.textAlign = "left";

        // CPU bar
        const vmCPU = (n.vms || []).reduce((s, v) => s + v.cpuCores, 0);
        const cpuLimit = n.cpuAllocatable || n.cpuCapacity || 1;
        const cpuPct = Math.min(vmCPU / cpuLimit, 1);
        const barX = x + 10;
        const barW = boxW - 20;
        const barH = 7;
        const cpuBarY = y + 34;

        ctx.fillStyle = "#cbd5e1";
        ctx.font = "bold 9px -apple-system, sans-serif";
        ctx.textBaseline = "bottom";
        ctx.fillText("CPU", barX, cpuBarY - 2);
        ctx.fillStyle = "#94a3b8";
        ctx.font = "9px -apple-system, sans-serif";
        ctx.textAlign = "right";
        ctx.fillText(vmCPU + "/" + cpuLimit, barX + barW, cpuBarY - 2);
        ctx.textAlign = "left";

        roundRect(ctx, barX, cpuBarY, barW, barH, 3);
        ctx.fillStyle = "#334155";
        ctx.fill();
        if (cpuPct > 0) {
            roundRect(ctx, barX, cpuBarY, Math.max(4, barW * cpuPct), barH, 3);
            ctx.fillStyle = cpuPct < 0.5 ? "#22c55e" : cpuPct < 0.8 ? "#eab308" : "#ef4444";
            ctx.fill();
        }

        // Memory bar
        const vmMem = (n.vms || []).reduce((s, v) => s + v.memoryMB, 0);
        const memLimit = n.memAllocMB || n.memoryCapMB || 1;
        const memPct = Math.min(vmMem / memLimit, 1);
        const memBarY = cpuBarY + 20;

        ctx.fillStyle = "#cbd5e1";
        ctx.font = "bold 9px -apple-system, sans-serif";
        ctx.textBaseline = "bottom";
        ctx.fillText("MEM", barX, memBarY - 2);
        ctx.fillStyle = "#94a3b8";
        ctx.font = "9px -apple-system, sans-serif";
        ctx.textAlign = "right";
        ctx.fillText((vmMem / 1024).toFixed(0) + "/" + (memLimit / 1024).toFixed(0) + " GB", barX + barW, memBarY - 2);
        ctx.textAlign = "left";

        roundRect(ctx, barX, memBarY, barW, barH, 3);
        ctx.fillStyle = "#334155";
        ctx.fill();
        if (memPct > 0) {
            roundRect(ctx, barX, memBarY, Math.max(4, barW * memPct), barH, 3);
            ctx.fillStyle = memPct < 0.5 ? "#22c55e" : memPct < 0.8 ? "#eab308" : "#ef4444";
            ctx.fill();
        }
    }

    function drawLegend(padding, H) {
        ctx.font = "11px -apple-system, sans-serif";
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        const legendY = H - 18;
        const items = [
            { color: "#22c55e", label: "Healthy" },
            { color: "#eab308", label: "Warning" },
            { color: "#ef4444", label: "Error" },
            { color: "#3b82f6", label: "Node Ready" },
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
            lx += ctx.measureText(item.label).width + 28;
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
