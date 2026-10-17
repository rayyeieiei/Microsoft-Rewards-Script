export class AccountSuspendedError extends Error {
    public readonly email: string
    public override readonly name = 'AccountSuspendedError'

    constructor(email: string, message?: string) {
        const defaultMsg = `🚨 [ACCOUNT-SUSPENDED] Akun ${email} TERBUKTI DITANGGUHKAN (BANNED) oleh Microsoft!`
        super(message || defaultMsg)
        this.email = email
        Object.setPrototypeOf(this, new.target.prototype)
    }
}
