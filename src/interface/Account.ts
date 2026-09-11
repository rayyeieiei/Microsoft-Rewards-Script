import { AppOnlyPolicy } from '../functions/activities/appOnly/AppOnlyTypes'

export interface Account {
    id?: string
    email: string
    password: string
    totpSecret?: string
    recoveryEmail: string
    geoLocale: 'auto' | string
    langCode: 'en' | string
    proxy: AccountProxy
    saveFingerprint: ConfigSaveFingerprint
    currentPoints?: number
    appOnlyPolicy?: AppOnlyPolicy
}

export interface AccountProxy {
    proxyAxios: boolean
    url: string
    port: number
    password: string
    username: string
}

export interface ConfigSaveFingerprint {
    mobile: boolean
    desktop: boolean
}
