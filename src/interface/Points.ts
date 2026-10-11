export interface BrowserEarnablePoints {
    desktopSearchPoints: number
    mobileSearchPoints: number
    dailySetPoints: number
    morePromotionsPoints: number
    totalEarnablePoints: number
}

export interface AppEarnablePoints {
    readToEarn: number
    checkIn: number
    totalEarnablePoints: number
    readToEarnProgress?: number
    readToEarnMax?: number
    readToEarnCompleted?: boolean
    readToEarnActivity?: any
}

export interface MissingSearchPoints {
    mobilePoints: number
    desktopPoints: number
    edgePoints: number
    totalPoints: number
}
