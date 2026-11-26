import { useEnvironment } from "../../environment-context";
import { useT } from "../../i18n";
import { useSettingsStore } from "../../stores/settings";
import { NtqqConfigSection } from "../onboarding/NtqqConfigSection";
import { CacheWarmingSettings } from "./CacheWarmingSettings";
import { SettingsSwitchRow } from "./SettingsSwitchRow";
import { TaskNotificationSettings } from "./TaskNotificationSettings";

/** 通用设置面板（中文单一界面；上下文蒸发为内置常开策略，不提供开关） */
export function GeneralPanel() {
	const t = useT();
	const environment = useEnvironment();
	const closeSettings = useSettingsStore((s) => s.setOpen);
	const channelWatchEnabled = useSettingsStore((s) => s.channelWatchEnabled);
	const setChannelWatchEnabled = useSettingsStore((s) => s.setChannelWatchEnabled);

	return (
		<div className="flex flex-col gap-6">
			<TaskNotificationSettings />
			<CacheWarmingSettings />
			<SettingsSwitchRow
				title={t("settings.channelWatch")}
				hint={t("settings.channelWatchHint")}
				checked={channelWatchEnabled === true}
				disabled={channelWatchEnabled === null}
				onCheckedChange={(enabled) => void setChannelWatchEnabled(enabled)}
			/>
			{environment.kind === "local" && (
				<div className="border-t border-border pt-5">
					<NtqqConfigSection
						showReopenOnboarding
						onReopenOnboarding={() => closeSettings(false)}
					/>
				</div>
			)}
		</div>
	);
}
