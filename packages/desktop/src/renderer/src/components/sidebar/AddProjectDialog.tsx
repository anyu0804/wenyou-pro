import { createPortal } from "react-dom";
import { useT } from "../../i18n";
import { useProjectsStore } from "../../stores/projects";
import { useWenyouCanvasStore } from "../../stores/wenyou-canvas";
import { Button } from "../ui/Button";

export function AddProjectDialog({
	onClose,
	onLocalProject,
}: {
	onClose: () => void;
	onLocalProject?: () => Promise<void>;
}) {
	const t = useT();
	return createPortal(
		<div
			role="dialog"
			aria-modal
			aria-label={t("sidebar.addProject")}
			className="fixed inset-0 z-40 flex items-center justify-center bg-ink/20"
		>
			<div className="w-[400px] max-w-[calc(100vw-32px)] rounded-xl border border-border bg-surface p-5 shadow-dialog">
				<h2 className="text-ui-14 font-semibold text-ink">{t("sidebar.addProject")}</h2>
				<p className="mt-1.5 text-ui-12 text-ink-dim">
					新建空白文游世界（不带模板，选定主群后由司命自动抓取建档），或打开已有项目目录。
				</p>
				<div className="mt-4 flex flex-col gap-2">
					<button
						type="button"
						onClick={() => {
							onClose();
							useWenyouCanvasStore.getState().setCreateWorldDialogOpen(true);
						}}
						className="w-full rounded-lg bg-ink px-3.5 py-2 text-ui-13 font-medium text-on-ink transition-opacity hover:opacity-90"
					>
						新建空白文游世界（绑群抓取）
					</button>
					<div className="flex justify-end gap-2 pt-1">
						<Button onClick={onClose}>{t("common.cancel")}</Button>
						<Button
							onClick={() => {
								onClose();
								void (onLocalProject ? onLocalProject() : useProjectsStore.getState().addProject());
							}}
						>
							{t("remote.localProject")}
						</Button>
					</div>
				</div>
			</div>
		</div>,
		document.body,
	);
}
