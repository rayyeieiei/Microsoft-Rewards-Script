import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios'
import axiosRetry from 'axios-retry'
import { HttpProxyAgent } from 'http-proxy-agent'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { SocksProxyAgent } from 'socks-proxy-agent'
import { URL } from 'url'
import type { AccountProxy } from '../interface/Account'
import { UserAgentManager } from '../browser/UserAgent'

class AxiosClient {
    private instance: AxiosInstance
    private account: AccountProxy

    constructor(
        account: AccountProxy,
        localProxyPort?: number,
        onBandwidth?: (bytes: number) => void,
        onSuspectedNetworkOutage?: (error: any) => void
    ) {
        this.account = account

        this.instance = axios.create({
            timeout: 20000,
            headers: {
                'User-Agent': UserAgentManager.DEFAULT_MOBILE_UA,
                'Accept': 'application/json, text/plain, */*',
                'Accept-Language': 'en-US,en;q=0.9',
                'Sec-Ch-Ua': '"Chromium";v="128", "Not;A=Brand";v="24", "Microsoft Edge";v="128"',
                'Sec-Ch-Ua-Mobile': '?1',
                'Sec-Ch-Ua-Platform': '"Android"',
                'Sec-Fetch-Site': 'same-origin',
                'Sec-Fetch-Mode': 'cors',
                'Sec-Fetch-Dest': 'empty'
            }
        })

        if (onSuspectedNetworkOutage) {
            this.instance.interceptors.response.use(
                response => response,
                error => {
                    if (!error?.response && error?.code && ['ENOTFOUND', 'ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH'].includes(error.code)) {
                        try {
                            onSuspectedNetworkOutage(error)
                        } catch {}
                    }
                    return Promise.reject(error)
                }
            )
        }

        if (onBandwidth) {
            this.instance.interceptors.response.use(response => {
                try {
                    const cl = response.headers?.['content-length']
                    if (cl) {
                        const bytes = parseInt(cl, 10)
                        if (!isNaN(bytes) && bytes > 0) {
                            onBandwidth(bytes)
                            return response
                        }
                    }
                    if (response.data) {
                        const len = typeof response.data === 'string'
                            ? response.data.length
                            : JSON.stringify(response.data).length
                        if (len > 0) onBandwidth(len)
                    }
                } catch {}
                return response
            })
        }

        if (this.account.url && this.account.proxyAxios) {
            const agent = this.getAgentForProxy(this.account)
            this.instance.defaults.httpAgent = agent
            this.instance.defaults.httpsAgent = agent
        } else if (localProxyPort) {
            const localProxyUrl = `http://127.0.0.1:${localProxyPort}`
            this.instance.defaults.httpAgent = new HttpProxyAgent(localProxyUrl)
            this.instance.defaults.httpsAgent = new HttpsProxyAgent(localProxyUrl)
        }

        axiosRetry(this.instance, {
            retries: 5,
            retryDelay: axiosRetry.exponentialDelay,
            shouldResetTimeout: true,
            retryCondition: error => {
                if (axiosRetry.isNetworkError(error)) return true
                if (!error.response) return true

                const status = error.response.status
                return status === 429 || (status >= 500 && status <= 599)
            }
        })
    }

    private getAgentForProxy(
        proxyConfig: AccountProxy
    ): HttpProxyAgent<string> | HttpsProxyAgent<string> | SocksProxyAgent {
        const { url: baseUrl, port, username, password } = proxyConfig

        let urlObj: URL
        try {
            urlObj = new URL(baseUrl)
        } catch (e) {
            try {
                urlObj = new URL(`http://${baseUrl}`)
            } catch (error) {
                throw new Error(`Invalid proxy URL format: ${baseUrl}`)
            }
        }

        const protocol = urlObj.protocol.toLowerCase()
        let proxyUrl: string

        if (username && password) {
            urlObj.username = encodeURIComponent(username)
            urlObj.password = encodeURIComponent(password)
            urlObj.port = port.toString()
            proxyUrl = urlObj.toString()
        } else {
            proxyUrl = `${protocol}//${urlObj.hostname}:${port}`
        }

        switch (protocol) {
            case 'http:':
                return new HttpProxyAgent(proxyUrl)
            case 'https:':
                return new HttpsProxyAgent(proxyUrl)
            case 'socks4:':
            case 'socks5:':
                return new SocksProxyAgent(proxyUrl)
            default:
                throw new Error(`Unsupported proxy protocol: ${protocol}. Only HTTP(S) and SOCKS4/5 are supported!`)
        }
    }

    public async request(config: AxiosRequestConfig, bypassProxy = false): Promise<AxiosResponse> {
        if (bypassProxy) {
            const bypassInstance = axios.create({
                headers: {
                    'User-Agent': UserAgentManager.DEFAULT_MOBILE_UA,
                    'Accept': 'application/json, text/plain, */*',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Sec-Ch-Ua': '"Chromium";v="128", "Not;A=Brand";v="24", "Microsoft Edge";v="128"',
                    'Sec-Ch-Ua-Mobile': '?1',
                    'Sec-Ch-Ua-Platform': '"Android"'
                }
            })
            axiosRetry(bypassInstance, {
                retries: 3,
                retryDelay: axiosRetry.exponentialDelay
            })
            return bypassInstance.request(config)
        }

        return this.instance.request(config)
    }
}

export default AxiosClient
