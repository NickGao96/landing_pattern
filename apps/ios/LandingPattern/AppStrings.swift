import Foundation

enum AppLanguage: String, Codable, CaseIterable, Identifiable {
    case en
    case zh

    var id: String { rawValue }

    static func defaultSystemLanguage(preferredLanguages: [String] = Locale.preferredLanguages) -> AppLanguage {
        for preferredLanguage in preferredLanguages {
            let normalized = preferredLanguage.replacingOccurrences(of: "_", with: "-").lowercased()
            if normalized == "zh" || normalized.hasPrefix("zh-") {
                return .zh
            }
            if normalized == "en" || normalized.hasPrefix("en-") {
                return .en
            }
        }

        return .en
    }

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
    let fetchWingsuitWindButton: String
    let headwindFinalButton: String
    let touchdownLabel: String
    let landingPointLabel: String
    let jumpRunStartLabel: String
    let jumpRunEndLabel: String
    let autoModeMapHint: String
    let selectedResult: String
    let modeSection: String
    let modeCanopy: String
    let modeWingsuit: String
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
    let entryGateLabel: String
    let turnOneGateLabel: String
    let turnTwoGateLabel: String
    let deployGateLabel: String
    let autoExitHeightLabel: String
    let autoDeployHeightLabel: String
    let reverseJumpRunButton: String
    let shearExponentLabel: String
    let canopySection: String
    let wingsuitSection: String
    let wingsuitPlanningModeLabel: String
    let wingsuitPlanningManual: String
    let wingsuitPlanningAuto: String
    let wingsuitAutoDisabledNotice: String
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
    let wingsuitPresetLabel: String
    let wingsuitPresetSwift: String
    let wingsuitPresetAtc: String
    let wingsuitPresetFreak: String
    let wingsuitPresetAura: String
    let wingsuitPresetCustom: String
    let wingsuitNameLabel: String
    let flightSpeedLabel: String
    let fallRateLabel: String
    let currentWingsuitSummary: (Double, Double, Double) -> String
    let windLayersSection: String
    let autoWindLayersHint: (Int) -> String
    let windAltLabel: String
    let windSpeedLabel: String
    let windFromLabel: String
    let outputsSection: String
    let wingLoadingLabel: String
    let estAirspeedLabel: String
    let estFlightSpeedLabel: String
    let estSinkLabel: String
    let wingsuitModelSummary: (String) -> String
    let autoFailureReasonLabel: String
    let autoPreferredBearingLabel: String
    let autoSelectedDeployLabel: String
    let autoExitErrorLabel: String
    let autoCorridorMarginLabel: String
    let autoEnvelopeMarginLabel: String
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
    let loadedUpperWind: (Int) -> String
    let loadedUpperWindFallback: (String) -> String
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
        title: "Flight Pattern Simulator (iOS V1)",
        locationSection: "Location",
        searchPlaceholder: "Search place or address",
        searchButton: "Search",
        fetchWindButton: "Fetch Wind",
        fetchWingsuitWindButton: "Fetch Upper Winds",
        headwindFinalButton: "Headwind Final",
        touchdownLabel: "Touchdown",
        landingPointLabel: "Landing Point",
        jumpRunStartLabel: "Jump Run Start",
        jumpRunEndLabel: "Jump Run End",
        autoModeMapHint: "Drag the landing pin to edit auto mode; jump run is resolved from wind and auto settings.",
        selectedResult: "selected result",
        modeSection: "Flight Mode",
        modeCanopy: "Canopy",
        modeWingsuit: "Wingsuit",
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
        entryGateLabel: "Exit Gate (ft)",
        turnOneGateLabel: "Turn 1 Gate (ft)",
        turnTwoGateLabel: "Turn 2 Gate (ft)",
        deployGateLabel: "Deploy Gate (ft)",
        autoExitHeightLabel: "Exit Height (ft)",
        autoDeployHeightLabel: "Deploy Height (ft)",
        reverseJumpRunButton: "Reverse Jump Run",
        shearExponentLabel: "Shear Exponent",
        canopySection: "Canopy + Jumper",
        wingsuitSection: "Wingsuit",
        wingsuitPlanningModeLabel: "Planning Mode",
        wingsuitPlanningManual: "Manual",
        wingsuitPlanningAuto: "Auto",
        wingsuitAutoDisabledNotice: "Wingsuit auto mode is temporarily disabled on iOS.",
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
        wingsuitPresetLabel: "Wingsuit Preset",
        wingsuitPresetSwift: "SWIFT",
        wingsuitPresetAtc: "ATC",
        wingsuitPresetFreak: "FREAK",
        wingsuitPresetAura: "AURA",
        wingsuitPresetCustom: "Custom",
        wingsuitNameLabel: "Wingsuit Name",
        flightSpeedLabel: "Horizontal Speed (kt)",
        fallRateLabel: "Fall Rate (ft/s)",
        currentWingsuitSummary: { speed, fallRate, glideRatio in
            String(format: "Horizontal %.1f kt, Vertical %.1f ft/s, Approx GR %.2f", speed, fallRate, glideRatio)
        },
        windLayersSection: "Wind Layers",
        autoWindLayersHint: { count in "Auto mode is using \(count) wind layers from ground to exit. You can edit any layer below." },
        windAltLabel: "Alt (ft)",
        windSpeedLabel: "Speed (kt)",
        windFromLabel: "From (deg)",
        outputsSection: "Outputs",
        wingLoadingLabel: "Wing Loading",
        estAirspeedLabel: "Est. Airspeed",
        estFlightSpeedLabel: "Horizontal Speed",
        estSinkLabel: "Est. Sink",
        wingsuitModelSummary: { name in "Wingsuit profile: \(name)" },
        autoFailureReasonLabel: "Failure",
        autoPreferredBearingLabel: "Preferred Deploy Bearing",
        autoSelectedDeployLabel: "Selected Deploy",
        autoExitErrorLabel: "Exit to Jump Run Error",
        autoCorridorMarginLabel: "Corridor Margin",
        autoEnvelopeMarginLabel: "Envelope Margin",
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
        loadedUpperWind: { count in "Loaded upper-air winds for \(count) active start altitude\(count == 1 ? "" : "s")." },
        loadedUpperWindFallback: { error in "Upper-air wind fetch failed. Fell back to extrapolated surface winds. \(error)" },
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
        title: "飞行航线模拟器 (iOS V1)",
        locationSection: "位置",
        searchPlaceholder: "搜索地点或地址",
        searchButton: "搜索",
        fetchWindButton: "获取风数据",
        fetchWingsuitWindButton: "获取高空风",
        headwindFinalButton: "迎风第三边",
        touchdownLabel: "着陆点",
        landingPointLabel: "落地点",
        jumpRunStartLabel: "航线起点",
        jumpRunEndLabel: "航线终点",
        autoModeMapHint: "可在地图上拖动落地点来编辑自动模式；航线由风和自动模式设置解析。",
        selectedResult: "已选结果",
        modeSection: "飞行模式",
        modeCanopy: "伞翼",
        modeWingsuit: "翼装",
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
        entryGateLabel: "出舱高度 (ft)",
        turnOneGateLabel: "第一转弯高度 (ft)",
        turnTwoGateLabel: "第二转弯高度 (ft)",
        deployGateLabel: "开伞高度 (ft)",
        autoExitHeightLabel: "出舱高度 (ft)",
        autoDeployHeightLabel: "开伞高度 (ft)",
        reverseJumpRunButton: "反转航线",
        shearExponentLabel: "风切变指数",
        canopySection: "伞翼与跳伞员",
        wingsuitSection: "翼装",
        wingsuitPlanningModeLabel: "规划模式",
        wingsuitPlanningManual: "手动",
        wingsuitPlanningAuto: "自动",
        wingsuitAutoDisabledNotice: "iOS 版暂时禁用翼装自动模式。",
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
        wingsuitPresetLabel: "翼装预设",
        wingsuitPresetSwift: "SWIFT",
        wingsuitPresetAtc: "ATC",
        wingsuitPresetFreak: "FREAK",
        wingsuitPresetAura: "AURA",
        wingsuitPresetCustom: "自定义",
        wingsuitNameLabel: "翼装名称",
        flightSpeedLabel: "水平速度 (kt)",
        fallRateLabel: "下沉率 (ft/s)",
        currentWingsuitSummary: { speed, fallRate, glideRatio in
            String(format: "水平速度 %.1f kt，垂直速度 %.1f ft/s，约滑翔比 %.2f", speed, fallRate, glideRatio)
        },
        windLayersSection: "分层风",
        autoWindLayersHint: { count in "自动模式当前使用从地面到出舱的 \(count) 个风层，可在下方逐层修改。" },
        windAltLabel: "高度 (ft)",
        windSpeedLabel: "速度 (kt)",
        windFromLabel: "来向 (度)",
        outputsSection: "输出",
        wingLoadingLabel: "翼载",
        estAirspeedLabel: "估算空速",
        estFlightSpeedLabel: "水平速度",
        estSinkLabel: "估算下沉",
        wingsuitModelSummary: { name in "翼装配置：\(name)" },
        autoFailureReasonLabel: "失败原因",
        autoPreferredBearingLabel: "偏好开伞方位",
        autoSelectedDeployLabel: "已选开伞点",
        autoExitErrorLabel: "出舱到航线误差",
        autoCorridorMarginLabel: "禁区余量",
        autoEnvelopeMarginLabel: "包线余量",
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
        loadedUpperWind: { count in "已加载 \(count) 个有效起始高度的高空风。" },
        loadedUpperWindFallback: { error in "高空风获取失败，已回退为地表风外推。\(error)" },
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
