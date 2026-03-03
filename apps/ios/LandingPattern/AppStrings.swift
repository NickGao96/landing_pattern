import Foundation

enum AppLanguage: String, Codable, CaseIterable, Identifiable {
    case en
    case zh

    var id: String { rawValue }

    var strings: AppStrings {
        switch self {
        case .en:
            return .english
        case .zh:
            return .chinese
        }
    }
}

struct AppStrings {
    let ready: String
    let languageSection: String
    let languageEnglish: String
    let languageChinese: String
    let title: String
    let locationSection: String
    let searchPlaceholder: String
    let searchButton: String
    let fetchWindButton: String
    let headwindFinalButton: String
    let touchdownLabel: String
    let selectedResult: String
    let patternSection: String
    let sideLabel: String
    let sideLeft: String
    let sideRight: String
    let driftBaseToggle: String
    let landingHeadingLabel: String
    let downwindGateLabel: String
    let baseGateLabel: String
    let finalGateLabel: String
    let touchdownGateLabel: String
    let shearExponentLabel: String
    let canopySection: String
    let presetLabel: String
    let canopySizeLabel: String
    let exitWeightLabel: String
    let airspeedRefLabel: String
    let wlRefLabel: String
    let glideRatioLabel: String
    let wlExponentLabel: String
    let airspeedMinLabel: String
    let airspeedMaxLabel: String
    let currentWlSummary: (Double, Double) -> String
    let windLayersSection: String
    let windAltLabel: String
    let windSpeedLabel: String
    let windFromLabel: String
    let outputsSection: String
    let wingLoadingLabel: String
    let estAirspeedLabel: String
    let estSinkLabel: String
    let noWarnings: String
    let importExportSection: String
    let exportSnapshotButton: String
    let importSnapshotButton: String
    let mapStackSection: String
    let mapStackMapKitOnly: String
    let mapStackTokenless: String
    let statusBlocked: String
    let statusCaution: String
    let statusValid: String
    let windLegendTitle: String
    let loadedWind: (String, Double, Int) -> String
    let autoWindFailed: (String) -> String
    let enterLocationQuery: String
    let locationSet: (String) -> String
    let noLocationResults: String
    let locationSearchFailed: (String) -> String
    let noWindLayerForSuggestion: String
    let headingSuggested: String
    let snapshotImported: String
    let snapshotExported: String
    let snapshotExportFailed: (String) -> String
    let snapshotImportFailed: (String) -> String

    static let english = AppStrings(
        ready: "Ready.",
        languageSection: "Language",
        languageEnglish: "English",
        languageChinese: "中文",
        title: "Landing Pattern (iOS V1)",
        locationSection: "Location",
        searchPlaceholder: "Search place or address",
        searchButton: "Search",
        fetchWindButton: "Fetch Wind",
        headwindFinalButton: "Headwind Final",
        touchdownLabel: "Touchdown",
        selectedResult: "selected result",
        patternSection: "Pattern",
        sideLabel: "Side",
        sideLeft: "Left",
        sideRight: "Right",
        driftBaseToggle: "Drift Base",
        landingHeadingLabel: "Landing Heading (deg)",
        downwindGateLabel: "Downwind Gate (ft)",
        baseGateLabel: "Base Gate (ft)",
        finalGateLabel: "Final Gate (ft)",
        touchdownGateLabel: "Touchdown Gate (ft)",
        shearExponentLabel: "Shear Exponent",
        canopySection: "Canopy + Jumper",
        presetLabel: "Preset",
        canopySizeLabel: "Canopy Size (sqft)",
        exitWeightLabel: "Exit Weight (lb)",
        airspeedRefLabel: "Airspeed Ref (kt)",
        wlRefLabel: "WL Ref",
        glideRatioLabel: "Glide Ratio",
        wlExponentLabel: "WL Exponent",
        airspeedMinLabel: "Airspeed Min",
        airspeedMaxLabel: "Airspeed Max",
        currentWlSummary: { wl, speed in
            String(format: "Current WL %.2f -> Modeled Airspeed %.1f kt", wl, speed)
        },
        windLayersSection: "Wind Layers",
        windAltLabel: "Alt (ft)",
        windSpeedLabel: "Speed (kt)",
        windFromLabel: "From (deg)",
        outputsSection: "Outputs",
        wingLoadingLabel: "Wing Loading",
        estAirspeedLabel: "Est. Airspeed",
        estSinkLabel: "Est. Sink",
        noWarnings: "No active warnings.",
        importExportSection: "Import / Export",
        exportSnapshotButton: "Export Snapshot JSON",
        importSnapshotButton: "Import Snapshot JSON",
        mapStackSection: "Map Stack",
        mapStackMapKitOnly: "Apple Map",
        mapStackTokenless: "Use Tokenless Satellite for external imagery when Apple map coverage looks weak.",
        statusBlocked: "Pattern blocked by safety model.",
        statusCaution: "Pattern computed with caution warnings.",
        statusValid: "Pattern valid.",
        windLegendTitle: "Wind",
        loadedWind: { source, speed, direction in
            "Loaded \(source) wind (\(String(format: "%.1f", speed)) kt from \(direction) deg)."
        },
        autoWindFailed: { error in
            "Auto wind failed. Use manual values. \(error)"
        },
        enterLocationQuery: "Enter a location query.",
        locationSet: { name in "Location set to \(name)." },
        noLocationResults: "No location results found.",
        locationSearchFailed: { error in "Location search failed: \(error)" },
        noWindLayerForSuggestion: "No wind layer available to suggest heading.",
        headingSuggested: "Landing heading set to headwind suggestion.",
        snapshotImported: "Snapshot imported.",
        snapshotExported: "Snapshot exported.",
        snapshotExportFailed: { error in "Snapshot export failed: \(error)" },
        snapshotImportFailed: { error in "Snapshot import failed: \(error)" }
    )

    static let chinese = AppStrings(
        ready: "就绪。",
        languageSection: "语言",
        languageEnglish: "English",
        languageChinese: "中文",
        title: "着陆航线模拟器 (iOS V1)",
        locationSection: "位置",
        searchPlaceholder: "搜索地点或地址",
        searchButton: "搜索",
        fetchWindButton: "获取风数据",
        headwindFinalButton: "迎风第三边",
        touchdownLabel: "着陆点",
        selectedResult: "已选结果",
        patternSection: "航线",
        sideLabel: "方向",
        sideLeft: "左",
        sideRight: "右",
        driftBaseToggle: "第二边随风",
        landingHeadingLabel: "着陆航向 (度)",
        downwindGateLabel: "第一边高度 (ft)",
        baseGateLabel: "第二边高度 (ft)",
        finalGateLabel: "第三边高度 (ft)",
        touchdownGateLabel: "接地点高度 (ft)",
        shearExponentLabel: "风切变指数",
        canopySection: "伞翼与跳伞员",
        presetLabel: "预设",
        canopySizeLabel: "伞翼面积 (sqft)",
        exitWeightLabel: "出舱重量 (lb)",
        airspeedRefLabel: "参考空速 (kt)",
        wlRefLabel: "参考翼载",
        glideRatioLabel: "滑翔比",
        wlExponentLabel: "翼载指数",
        airspeedMinLabel: "最小空速",
        airspeedMaxLabel: "最大空速",
        currentWlSummary: { wl, speed in
            String(format: "当前翼载 %.2f -> 模型空速 %.1f kt", wl, speed)
        },
        windLayersSection: "分层风",
        windAltLabel: "高度 (ft)",
        windSpeedLabel: "速度 (kt)",
        windFromLabel: "来向 (度)",
        outputsSection: "输出",
        wingLoadingLabel: "翼载",
        estAirspeedLabel: "估算空速",
        estSinkLabel: "估算下沉",
        noWarnings: "当前无警告。",
        importExportSection: "导入 / 导出",
        exportSnapshotButton: "导出快照 JSON",
        importSnapshotButton: "导入快照 JSON",
        mapStackSection: "地图方案",
        mapStackMapKitOnly: "Apple 地图",
        mapStackTokenless: "当 Apple 地图影像不理想时，可切换到免令牌卫星底图。",
        statusBlocked: "航线被安全模型拦截。",
        statusCaution: "航线已计算，但包含警告。",
        statusValid: "航线有效。",
        windLegendTitle: "风",
        loadedWind: { source, speed, direction in
            "已加载 \(source) 风数据（\(String(format: "%.1f", speed)) kt，来向 \(direction) 度）。"
        },
        autoWindFailed: { error in
            "自动获取风失败，请使用手动输入。\(error)"
        },
        enterLocationQuery: "请输入位置关键字。",
        locationSet: { name in "位置已设置为 \(name)。" },
        noLocationResults: "未找到位置结果。",
        locationSearchFailed: { error in "位置搜索失败：\(error)" },
        noWindLayerForSuggestion: "没有可用于建议航向的风层。",
        headingSuggested: "已设置为迎风航向。",
        snapshotImported: "快照已导入。",
        snapshotExported: "快照已导出。",
        snapshotExportFailed: { error in "快照导出失败：\(error)" },
        snapshotImportFailed: { error in "快照导入失败：\(error)" }
    )
}
