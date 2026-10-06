const setName = '茶话会小剧场 · 插件入口';
const label = '茶话会小剧场';
const command = '/teahouse';

// Called serially after Quick Reply has initialized, or from the entrance settings.
export async function syncQrEntry(api, enabled) {
    if (!api) {
        if (enabled) throw new Error('酒馆的快速回复功能尚未就绪，请稍后重新开启 QR 入口。');
        return;
    }
    let set = api.getSetByName(setName);
    if (!enabled && !set) return;
    if (!set) set = await api.createSet(setName, { disableSend: false, injectInput: false });
    let qr = api.getQrByLabel(setName, label);
    if (qr && qr.message !== command) throw new Error('同名 QR 已被修改，请在快速回复中为它改名后重新开启入口。');
    if (enabled) {
        if (!qr) qr = api.createQuickReply(setName, label, {
            message: command, icon: 'fa-mug-hot', showLabel: false, title: '茶话会小剧场',
        });
        else if (qr.isHidden) api.updateQuickReply(setName, label, { isHidden: false });
        api.addGlobalSet(setName);
        // The host's master switch belongs to the user; changing it affects every QR.
    } else {
        if (qr && !qr.isHidden) api.updateQuickReply(setName, label, { isHidden: true });
        api.removeGlobalSet(setName);
    }
}
