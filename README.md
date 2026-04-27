# KubeVirt Status Page

This project is a status page application that provides a graphical view of KubeVirt nodes and the virtual machines (VMs) scheduled on each node. The application groups machines in clusters and displays allocation per node in a graph format.

## Project Structure

```
kubevirt-status-page
├── cmd
│   └── server
│       └── main.go          # Entry point of the Go application
├── internal
│   ├── kubevirt
│   │   ├── client.go        # KubeVirt client implementation
│   │   └── types.go         # Data structures for KubeVirt nodes and VMs
│   ├── cluster
│   │   └── aggregator.go     # Logic to aggregate data from KubeVirt nodes
│   └── sse
│       └── handler.go       # Server-Sent Events (SSE) handler
├── web
│   ├── static
│   │   ├── index.html       # Main HTML file for the frontend
│   │   ├── style.css        # Styles for the frontend
│   │   └── app.js           # JavaScript code for frontend logic
│   └── embed.go             # Embedding static files into the Go binary
├── Dockerfile                # Instructions for building the Docker image
├── go.mod                   # Go module definition file
├── go.sum                   # Checksums for module dependencies
├── Makefile                 # Build and deployment commands
└── README.md                # Project documentation
```

## Setup Instructions

1. **Clone the repository:**
   ```
   git clone https://github.com/vitistack/kubevirt-status-page.git
   cd kubevirt-status-page
   ```

2. **Build the application:**
   ```
   make build
   ```

3. **Run the application:**
   ```
   make run
   ```

4. **Access the status page:**
   Open your web browser and navigate to `http://localhost:8080` to view the KubeVirt status page.

## Helm Chart Installation

The application can be deployed to a Kubernetes cluster using the Helm chart.

### Prerequisites

- Kubernetes cluster with KubeVirt installed
- Helm 3.x

### Install from OCI registry

```bash
helm install kubevirt-status-page oci://ghcr.io/vitistack/helm/kubevirt-status-page --version <version>
```

### Install from source

```bash
helm install kubevirt-status-page ./charts/kubevirt-status-page
```

### Configuration

Key values can be overridden during installation:

```bash
helm install kubevirt-status-page oci://ghcr.io/vitistack/helm/kubevirt-status-page \
  --set ingress.enabled=true \
  --set ingress.hosts[0].host=status.example.com \
  --set ingress.hosts[0].paths[0].path=/ \
  --set ingress.hosts[0].paths[0].pathType=ImplementationSpecific
```

| Parameter | Description | Default |
|---|---|---|
| `replicaCount` | Number of replicas | `1` |
| `image.repository` | Container image | `ghcr.io/vitistack/kubevirt-status-page` |
| `image.tag` | Image tag (defaults to chart appVersion) | `""` |
| `service.type` | Service type | `ClusterIP` |
| `service.port` | Service port | `80` |
| `ingress.enabled` | Enable ingress | `false` |
| `kubeContext` | Kubernetes context (empty for in-cluster) | `""` |
| `kubeconfig.secretName` | Name of secret containing kubeconfig | `""` |
| `kubeconfig.secretKey` | Key in secret with kubeconfig data | `"kubeconfig"` |

### Using an external kubeconfig

By default the application uses the in-cluster service account to access the Kubernetes API. To monitor a **remote** KubeVirt cluster, provide a kubeconfig file via a Kubernetes secret:

1. Create the secret from your kubeconfig file:

   ```bash
   kubectl create secret generic kubevirt-kubeconfig \
     --from-file=kubeconfig=/path/to/remote-kubeconfig
   ```

2. Install the chart referencing the secret:

   ```bash
   helm install kubevirt-status-page oci://ghcr.io/vitistack/helm/kubevirt-status-page \
     --set kubeconfig.secretName=kubevirt-kubeconfig
   ```

3. Optionally select a specific context from the kubeconfig:

   ```bash
   helm install kubevirt-status-page oci://ghcr.io/vitistack/helm/kubevirt-status-page \
     --set kubeconfig.secretName=kubevirt-kubeconfig \
     --set kubeContext=admin@my-cluster
   ```

If the secret key is named something other than `kubeconfig`, set `kubeconfig.secretKey` accordingly.

### Uninstall

```bash
helm uninstall kubevirt-status-page
```

## Usage

The application connects to the KubeVirt cluster and retrieves information about nodes and VMs. It uses Server-Sent Events (SSE) to provide real-time updates to the frontend, ensuring that the status page reflects the current state of the cluster.

## Contributing

Contributions are welcome! Please open an issue or submit a pull request for any enhancements or bug fixes.

## License

This project is licensed under the MIT License. See the LICENSE file for more details.