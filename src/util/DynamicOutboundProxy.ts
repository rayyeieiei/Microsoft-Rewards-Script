import http from 'http'
import net from 'net'
import os from 'os'
import stream from 'stream'
import { URL } from 'url'
import type { Logger } from '../logging/Logger'

export class DynamicOutboundProxy {
    private server: http.Server | null = null
    private currentWifiIp = ''
    private logger: Logger
    private sockets = new Set<net.Socket | stream.Duplex>()
    private stopPromise: Promise<void> | null = null
    private isStopping = false

    constructor(private port: number = 0, logger: Logger) {
        this.logger = logger
        this.updateWifiIp()
    }

    /**
     * Mendeteksi IP lokal dari adapter Wi-Fi di Windows secara real-time
     */
    private updateWifiIp(): string {
        const interfaces = os.networkInterfaces()
        let foundIp = ''

        for (const name of Object.keys(interfaces)) {
            if (name.toLowerCase().includes('wi-fi') || name.toLowerCase().includes('wireless')) {
                const iface = interfaces[name]
                if (iface) {
                    const ipv4 = iface.find(details => details.family === 'IPv4' && !details.internal)
                    if (ipv4) {
                        foundIp = ipv4.address
                        break
                    }
                }
            }
        }

        if (foundIp) {
            this.currentWifiIp = foundIp
        } else {
            // Fallback default jika adapter tidak terdeteksi
            this.currentWifiIp = '127.0.0.1'
        }
        return this.currentWifiIp
    }

    private getRawWifiIp(): string {
        const interfaces = os.networkInterfaces()
        for (const name of Object.keys(interfaces)) {
            if (name.toLowerCase().includes('wi-fi') || name.toLowerCase().includes('wireless')) {
                const iface = interfaces[name]
                if (iface) {
                    const ipv4 = iface.find(details => details.family === 'IPv4' && !details.internal)
                    if (ipv4) {
                        return ipv4.address
                    }
                }
            }
        }
        return ''
    }

    public async ensureWifiConnected(): Promise<string> {
        let ip = this.getRawWifiIp()
        if (ip) {
            this.currentWifiIp = ip
            return ip
        }

        this.logger.warn('main', 'NETWORK-GUARD', '=======================================================', 'yellow')
        this.logger.warn('main', 'NETWORK-GUARD', '⚠️ KONEKSI WI-FI HOTSPOT TERPUTUS! PAUSING EXECUTION...', 'yellow')
        this.logger.warn('main', 'NETWORK-GUARD', '🔊 Memutar suara notifikasi... Menunggu Wi-Fi PC terhubung kembali ke Hotspot HP...', 'yellow')
        this.logger.warn('main', 'NETWORK-GUARD', '=======================================================', 'yellow')

        try {
            require('child_process').exec(`powershell -c (New-Object Media.SoundPlayer "C:\\Windows\\Media\\notify.wav").PlaySync();`);
        } catch {}

        while (!ip) {
            await new Promise(resolve => setTimeout(resolve, 3000))
            ip = this.getRawWifiIp()
        }

        this.logger.info('main', 'NETWORK-GUARD', `🚀 SUKSES! Wi-Fi Terhubung Kembali! IP Baru: [ ${ip} ]`, 'green')
        try {
            require('child_process').exec(`powershell -c (New-Object Media.SoundPlayer "C:\\Windows\\Media\\notify.wav").PlaySync();`);
        } catch {}

        this.currentWifiIp = ip
        return ip
    }

    /**
     * Memulai server proxy lokal
     */
    public start(): Promise<void> {
        return new Promise((resolve, reject) => {
            this.server = http.createServer(async (req, res) => {
                const wifiIp = await this.ensureWifiConnected()
                this.logger.debug('main', 'LOCAL-PROXY-HTTP', `Routing ${req.method} request to ${req.url || ''} via IP: [ ${wifiIp} ]`)

                try {
                    const urlObj = new URL(req.url || '')
                    const options: http.RequestOptions = {
                        hostname: urlObj.hostname,
                        port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
                        path: urlObj.pathname + urlObj.search,
                        method: req.method,
                        headers: req.headers,
                        localAddress: wifiIp,
                        family: 4,
                        agent: false
                    }

                    const proxyReq = http.request(options, (proxyRes) => {
                        res.writeHead(proxyRes.statusCode || 200, proxyRes.headers)
                        proxyRes.pipe(res)
                    })

                    proxyReq.on('error', (err) => {
                        this.logger.error('main', 'LOCAL-PROXY-HTTP-ERROR', `Request to ${req.url || ''} failed: ${err.message}`)
                        res.writeHead(502)
                        res.end(`Bad Gateway: ${err.message}`)
                    })

                    req.pipe(proxyReq)
                } catch (e) {
                    const errMsg = e instanceof Error ? e.message : String(e)
                    this.logger.error('main', 'LOCAL-PROXY-HTTP-ERROR', `Failed to parse URL ${req.url || ''}: ${errMsg}`)
                    res.writeHead(400)
                    res.end('Invalid request')
                }
            })

            // Track incoming client connections
            this.server.on('connection', (socket: net.Socket) => {
                if (this.isStopping) {
                    socket.destroy()
                    return
                }
                this.sockets.add(socket)
                socket.once('close', () => this.sockets.delete(socket))
            })

            // CONNECT tunnel untuk HTTPS
            this.server.on('connect', async (req, clientSocket, head) => {
                if (this.isStopping) {
                    clientSocket.destroy()
                    return
                }
                this.sockets.add(clientSocket)
                clientSocket.once('close', () => this.sockets.delete(clientSocket))

                const wifiIp = await this.ensureWifiConnected()
                this.logger.debug('main', 'LOCAL-PROXY-CONNECT', `Establishing HTTPS tunnel to ${req.url || ''} via IP: [ ${wifiIp} ]`)

                const parts = req.url?.split(':')
                if (!parts || parts.length !== 2) {
                    clientSocket.write('HTTP/1.1 400 Bad Request\r\n\r\n')
                    clientSocket.end()
                    return
                }

                const host = parts[0] as string
                const port = parseInt(parts[1] as string, 10)

                const serverSocket = net.connect({
                    host: host,
                    port: port,
                    localAddress: wifiIp,
                    family: 4
                }, () => {
                    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
                    if (head && head.length > 0) {
                        serverSocket.write(head)
                    }
                    clientSocket.pipe(serverSocket)
                    serverSocket.pipe(clientSocket)
                })

                this.sockets.add(serverSocket)
                serverSocket.once('close', () => this.sockets.delete(serverSocket))

                serverSocket.on('error', (err) => {
                    this.logger.debug('main', 'LOCAL-PROXY-CONNECT-ERROR', `Tunnel connection to ${host}:${port} failed: ${err.message}`)
                    clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n')
                    clientSocket.end()
                })

                clientSocket.on('error', () => {
                    serverSocket.end()
                })
            })

            this.server.on('error', (err) => {
                this.logger.error('main', 'LOCAL-PROXY-SERVER-ERROR', `Server error: ${err.message}`)
                reject(err)
            })

            this.server.listen(this.port, '127.0.0.1', () => {
                const address = this.server?.address()
                if (address && typeof address !== 'string') {
                    this.port = address.port
                }
                resolve()
            })
        })
    }

    public getPort(): number {
        return this.port
    }

    public getWifiIp(): string {
        return this.currentWifiIp
    }

    public getTrackedSocketCount(): number {
        return this.sockets.size
    }

    public getIsStopping(): boolean {
        return this.isStopping
    }

    public stop(timeoutMs: number = 3000): Promise<void> {
        if (this.stopPromise) {
            return this.stopPromise
        }
        this.isStopping = true

        this.stopPromise = new Promise<void>((resolve) => {
            let completed = false
            const finish = () => {
                if (completed) return
                completed = true
                this.server = null
                resolve()
            }

            const timer = setTimeout(() => {
                for (const socket of this.sockets) {
                    try {
                        socket.destroy()
                    } catch {}
                }
                this.sockets.clear()
                finish()
            }, timeoutMs)

            // Destroy all currently tracked sockets immediately
            for (const socket of this.sockets) {
                try {
                    socket.destroy()
                } catch {}
            }
            this.sockets.clear()

            if (this.server) {
                this.server.close(() => {
                    clearTimeout(timer)
                    finish()
                })
            } else {
                clearTimeout(timer)
                finish()
            }
        })

        return this.stopPromise
    }
}
