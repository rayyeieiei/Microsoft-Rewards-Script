import assert from 'assert'
import os from 'os'
import { AirplaneMode } from '../src/util/AirplaneMode'
import { DynamicOutboundProxy } from '../src/util/DynamicOutboundProxy'
import { MicrosoftRewardsBot } from '../src/index'

export async function runChapter31UsbTetheringAndNetworkGuardTests(): Promise<void> {
    console.log('\n--- Running Chapter 31 USB Tethering & Network Guard Test Suite ---')

    const dummyLogger = {
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {}
    } as any

    // Test 1: AirplaneMode.disableUsbTethering handles disconnected device gracefully without throwing
    {
        // Gunakan serial fiktif agar checkDevice mengembalikan ready: false
        const res = await AirplaneMode.disableUsbTethering('fictitious-device-99999')
        assert.strictEqual(res, false, 'disableUsbTethering should return false gracefully when device is missing')
        console.log('✅ Test 1 Passed: AirplaneMode.disableUsbTethering gracefully handles absent device without crashing')
    }

    // Test 2: AirplaneMode.enableUsbTethering handles disconnected device gracefully without throwing
    {
        const res = await AirplaneMode.enableUsbTethering('fictitious-device-99999')
        assert.strictEqual(res, false, 'enableUsbTethering should return false gracefully when device is missing')
        console.log('✅ Test 2 Passed: AirplaneMode.enableUsbTethering gracefully handles absent device without crashing')
    }

    // Test 3: MicrosoftRewardsBot.tryDisableUsbTethering runs cleanly in zero-device environment
    {
        const bot = new MicrosoftRewardsBot()
        bot.config = {
            ...bot.config,
            useAdbIpRotation: false,
            networkRecovery: {
                enabled: false,
                mode: 'conservative',
                operatorTrigger: false,
                connectivityFailureTrigger: false,
                adbSerial: 'fictitious-device-99999',
                reassertUsbTethering: false
            }
        } as any

        const result = await bot.tryDisableUsbTethering()
        assert.strictEqual(typeof result, 'boolean', 'tryDisableUsbTethering should return a boolean')
        console.log('✅ Test 3 Passed: MicrosoftRewardsBot.tryDisableUsbTethering safely completes in mock environment')
    }

    // Test 4: DynamicOutboundProxy detects USB Tethering subnet (192.168.42.x) with highest priority
    {
        const originalNetworkInterfaces = os.networkInterfaces
        try {
            // Mock os.networkInterfaces to simulate dual NIC: LAN + Android USB Tethering (192.168.42.x)
            os.networkInterfaces = () => ({
                'Ethernet': [
                    {
                        address: '192.168.1.100',
                        netmask: '255.255.255.0',
                        family: 'IPv4',
                        mac: '00:11:22:33:44:55',
                        internal: false,
                        cidr: '192.168.1.100/24'
                    }
                ],
                'Ethernet 2': [
                    {
                        address: '192.168.42.129',
                        netmask: '255.255.255.0',
                        family: 'IPv4',
                        mac: 'aa:bb:cc:dd:ee:ff',
                        internal: false,
                        cidr: '192.168.42.129/24'
                    }
                ],
                'Wi-Fi': [
                    {
                        address: '192.168.0.50',
                        netmask: '255.255.255.0',
                        family: 'IPv4',
                        mac: '11:22:33:44:55:66',
                        internal: false,
                        cidr: '192.168.0.50/24'
                    }
                ]
            })

            const proxy = new DynamicOutboundProxy(0, dummyLogger)
            // Akses private getRawWifiIp via any untuk verifikasi prioritas IP
            const detectedIp = (proxy as any).getRawWifiIp()
            assert.strictEqual(detectedIp, '192.168.42.129', 'DynamicOutboundProxy must prioritize 192.168.42.x Android USB tethering subnet over Wi-Fi and standard Ethernet')
            console.log('✅ Test 4 Passed: DynamicOutboundProxy strictly prioritizes Android USB Tethering (192.168.42.x) subnet')
        } finally {
            os.networkInterfaces = originalNetworkInterfaces
        }
    }

    // Test 5: DynamicOutboundProxy falls back to Wi-Fi when USB Tethering is not present
    {
        const originalNetworkInterfaces = os.networkInterfaces
        try {
            os.networkInterfaces = () => ({
                'Local Area Connection': [
                    {
                        address: '10.0.0.5',
                        netmask: '255.255.255.0',
                        family: 'IPv4',
                        mac: '00:11:22:33:44:55',
                        internal: false,
                        cidr: '10.0.0.5/24'
                    }
                ],
                'Wi-Fi': [
                    {
                        address: '192.168.43.15',
                        netmask: '255.255.255.0',
                        family: 'IPv4',
                        mac: '11:22:33:44:55:66',
                        internal: false,
                        cidr: '192.168.43.15/24'
                    }
                ]
            })

            const proxy = new DynamicOutboundProxy(0, dummyLogger)
            const detectedIp = (proxy as any).getRawWifiIp()
            assert.strictEqual(detectedIp, '192.168.43.15', 'DynamicOutboundProxy must prioritize Wi-Fi over generic LAN when USB Tethering is absent')
            console.log('✅ Test 5 Passed: DynamicOutboundProxy correctly falls back to Wi-Fi adapter')
        } finally {
            os.networkInterfaces = originalNetworkInterfaces
        }
    }

    // Test 6: DynamicOutboundProxy defaults to 127.0.0.1 when no external interfaces exist
    {
        const originalNetworkInterfaces = os.networkInterfaces
        try {
            os.networkInterfaces = () => ({
                'Loopback Pseudo-Interface 1': [
                    {
                        address: '127.0.0.1',
                        netmask: '255.0.0.0',
                        family: 'IPv4',
                        mac: '00:00:00:00:00:00',
                        internal: true,
                        cidr: '127.0.0.1/8'
                    }
                ]
            })

            const proxy = new DynamicOutboundProxy(0, dummyLogger)
            const ip = (proxy as any).updateWifiIp()
            assert.strictEqual(ip, '127.0.0.1', 'DynamicOutboundProxy must safely fallback to 127.0.0.1')
            console.log('✅ Test 6 Passed: DynamicOutboundProxy safely falls back to 127.0.0.1 when disconnected')
        } finally {
            os.networkInterfaces = originalNetworkInterfaces
        }
    }

    console.log('🏁 All Chapter 31 USB Tethering & Network Guard tests passed successfully!\n')
}

if (require.main === module) {
    runChapter31UsbTetheringAndNetworkGuardTests().catch(err => {
        console.error('❌ Chapter 31 Tests Failed:', err)
        process.exit(1)
    })
}
