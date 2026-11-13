importScripts('firebase-sync.js');

const isMobile = /Android|Mobile|Lemur|Kiwi/i.test(navigator.userAgent);

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    
    // --- ÄNDRAD LOGIK FÖR ATT STÄNGA FÖNSTER / KEDJESÖKNING ---
    if (request.action === 'CLOSE_WINDOW') {
        chrome.storage.local.get(['os_combo_queue', 'os_combo_regnr', 'fordonsdata_result', 'fordonsdata_combo_buffer', 'os_search_history'], (res) => {
            
            if (res.fordonsdata_result) {
                saveVehicleToCloud(res.fordonsdata_result); // Här skjuter vi upp datan till molnet!
            }

            // 1. Är vi mitt i en kombinerad sökning?
            if (res.os_combo_queue && res.os_combo_queue.length > 0) {
                let buffer = res.fordonsdata_combo_buffer || [];
                if (res.fordonsdata_result) {
                    buffer.push(res.fordonsdata_result);
                    chrome.storage.local.remove('fordonsdata_result'); 
                }
                
                let queue = res.os_combo_queue;
                queue.shift(); 

                if (queue.length > 0) {
                    // Fortsätt kedjan
                    chrome.storage.local.set({ 'os_combo_queue': queue, 'fordonsdata_combo_buffer': buffer }, () => {
                        const nextTarget = queue[0];
                        const regnr = res.os_combo_regnr;
                        let nextUrl = "";
                        
                        if (nextTarget === 'om') nextUrl = 'https://www.oljemagasinet.se';
                        else if (nextTarget === 'bu') nextUrl = `https://biluppgifter.se/fordon/${regnr}`;
                        else if (nextTarget === 'ci') nextUrl = `https://www.car.info/sv-se/license-plate/S/${regnr}#specs_bmg_export`;

                        chrome.storage.local.set({
                            'os_external_task': { regnr: regnr, target: nextTarget }
                            // Vi har tagit bort raden som tvingade "popup" här, 
                            // så systemet kommer ihåg att vi kom från Serviceprotokollet!
                        }, () => {
                            if (sender.tab && sender.tab.id) chrome.tabs.update(sender.tab.id, { url: nextUrl });
                        });
                    });
                    return; 
                } else {
                    // KEDJAN ÄR KLAR! Nu slår vi ihop datan smart och kraftfullt
                    let merged = {};
                    buffer.forEach(data => {
                        Object.keys(data).forEach(key => {
                            let val = data[key];
                            // NYTT: Ignorera "Okänd modell" så Oljemagasinet får chansen att skriva in rätt märke
                            if (val && val !== "SAKNAS" && val !== "-" && val !== "Okänd modell") {
                                // Oljemagasinet vinner över Car.info gällande motorkod, oljevolym OCH bilmodell!
                                if ((key === 'motorkod' || key === 'oljevolym' || key === 'bilmodell') && data.source === 'Oljemagasinet_Extension') {
                                    merged[key] = val;
                                } 
                                else if (!merged[key]) {
                                    merged[key] = val;
                                }
                            }
                        });
                    });
                    
                    merged.source = 'AutoSearch_Extension'; // Tvingar namnet så Serviceprotokollet känner igen det

                    // Spara den perfekta kombon i tilläggets historik automatiskt
                    let history = res.os_search_history || [];
                    if (merged.regnr) {
                        history = history.filter(h => h.regnr !== merged.regnr);
                        history.unshift(merged);
                        if (history.length > 10) history = history.slice(0, 10);
                    }

                    // Skicka den slutgiltiga, felfria datan till Serviceprotokollet
                    chrome.storage.local.set({ 
                        'os_search_history': history,
                        'fordonsdata_result': merged 
                    });

                    chrome.storage.local.remove(['os_combo_queue', 'os_combo_regnr', 'fordonsdata_combo_buffer']);
                }
            }

            // 2. Standard-avslut
            if (sender.tab && sender.tab.id) {
                chrome.storage.local.get(['os_external_task_origin', 'os_active_ui'], (originRes) => {
                    const uiFile = originRes.os_active_ui || 'popup.html';
                    if (isMobile && originRes.os_external_task_origin === 'popup') {
                        chrome.tabs.update(sender.tab.id, { url: chrome.runtime.getURL(`${uiFile}?mobile_return=true`) });
                    } else {
                        chrome.tabs.remove(sender.tab.id).catch(() => {});
                    }
                    chrome.storage.local.remove('os_external_task_origin'); 
                });
            }
        });
    }

    if (request.action === 'INJECT_SCRAPER') {
        const tabId = sender.tab ? sender.tab.id : request.tabId;
        if (tabId) {
            chrome.scripting.executeScript({
                target: { tabId: tabId },
                files: [request.scriptFile] 
            }).then(() => {
                console.log(`Injicerade ${request.scriptFile}`);
            }).catch(err => console.error("Fel:", err));
        }
    }

    if (request.action === 'OPEN_POPUP_FOR_REG') {
        const payload = { 'pending_context_search': request.regnr };
        if (request.engine) payload['pending_context_engine'] = request.engine;
        chrome.storage.local.set(payload, () => {
            if (isMobile) {
                chrome.tabs.create({ url: chrome.runtime.getURL("popup.html"), active: true });
            } else {
                chrome.windows.create({ url: chrome.runtime.getURL("popup.html"), type: 'popup', width: 420, height: 650, focused: true });
            }
        });
    }

    if (request.action === 'OPEN_EXTERNAL_SCRAPER') {
        chrome.storage.local.set({
            'os_external_task': { regnr: request.regnr, target: request.target },
            'os_external_task_origin': request.origin || 'popup' 
        }, () => {
            // Tvingar fram ett litet popup-fönster oavsett enhet!
            chrome.windows.create({ 
                url: request.url, 
                type: 'popup', 
                width: 450, 
                height: 550, 
                left: 9999, 
                top: 9999, 
                focused: false 
            }, (win) => {
                // Fallback: Om Kiwi tvingar en flik, öppnas den osynligt i bakgrunden (active: false)
                if (chrome.runtime.lastError || !win) {
                    chrome.tabs.create({ url: request.url, active: false });
                }
            });
        });
    }

    // NYTT: Utför den osynliga hämtningen från SuperETKA och returnerar resultatet
    if (request.action === 'FETCH_ETKA_OEM') {
        const fetchEtka = async () => {
            const partsToFetch = [ 
                {name:'Oljefilter', code:'RCO'}, {name:'Luftfilter', code:'RCE'}, 
                {name:'Kupéfilter', code:'RCP'}, {name:'Bränslefilter', code:'RCK'}, 
                {name:'Tändstift/Glödstift', code:'NEZ'} 
            ];
            const results = [];
            for (let part of partsToFetch) {
                try {
                    const res = await fetch(`https://superetka.com/etka/wap.php?cat=spareGroup&vin=${request.vin}&spare=1&spareGroup=${part.code}`);
                    const text = await res.text();
                    // Letar efter strikta OEM-mönster och ignorerar bilens eget VIN
                    const matches = text.match(/\b[0-9][A-Z0-9]{2}[\s\-]?[A-Z0-9]{3}[\s\-]?[A-Z0-9]{2,4}\b/gi) || [];
                    const validPart = matches.find(m => !request.vin.includes(m.replace(/[^A-Z0-9]/gi, '')));
                    if(validPart) results.push({ name: part.name, oem: validPart.replace(/[^A-Z0-9]/ig, '') });
                } catch(e) {}
            }
            sendResponse(results);
        };
        fetchEtka();
        return true; 
    }

    if (request.action === 'OPEN_TAB_DIRECT') {
        chrome.tabs.create({ url: request.url, active: request.active !== false });
    }

    if (request.action === 'SET_CONTEXT_TYPE') {
        lastRightClickVal = request.val || '';
        updateContextMenuVisibility(request.contextType);
    }
});

// ==========================================
// HÖGERKLICK (Får använda den vanliga dropdown-menyn)
// ==========================================
let currentContextType = 'reg';
let lastRightClickVal = '';
let cachedRegBtns = ['search', 'bu-scrape', 'ci-direct', 'bu-direct'];
let cachedVinBtns = ['etka', 'etkaweb', '7zap', 'partsouq', 'copy'];
let cachedMenuMode = 'submenu';

const REG_MENU_ITEMS = [
    { key: 'search', id: 'bmg-search-reg', title: "🟠  Sök Fordon: '%s'" },
    { key: 'porsche', id: 'porsche-search-reg', title: "🔵  Porsche Service: '%s'" },
    { key: 'bu-scrape', id: 'bmg-search-bu', title: "🟢  Sök via Biluppgifter: '%s'" },
    { key: 'ci-direct', id: 'open-ci-direct', title: "⚪  Öppna Car.info direkt: '%s'" },
    { key: 'bu-direct', id: 'open-bu-direct', title: "⚪  Öppna Biluppgifter direkt: '%s'" }
];

const VIN_MENU_ITEMS = [
    { key: 'etka', id: 'vin-open-etka', title: "🟠  SuperETKA: '%s'" },
    { key: 'etkaweb', id: 'vin-open-etkaweb', title: "🔵  ETKA: '%s'" },
    { key: 'porsche', id: 'vin-open-porsche', title: "🔵  Porsche Service: '%s'" },
    { key: '7zap', id: 'vin-open-7zap', title: "🟢  7zap OEM: '%s'" },
    { key: 'partsouq', id: 'vin-open-partsouq', title: "⚪  PartSouq: '%s'" }
];

function updateContextMenuVisibility(type = currentContextType) {
    currentContextType = type;
    if (cachedMenuMode === 'direct') return;

    const showReg = type === 'reg';
    const showVin = type === 'vin';

    REG_MENU_ITEMS.forEach(item => {
        chrome.contextMenus.update(item.id, {
            visible: showReg && cachedRegBtns.includes(item.key)
        }, () => { void chrome.runtime.lastError; });
    });

    VIN_MENU_ITEMS.forEach(item => {
        chrome.contextMenus.update(item.id, {
            visible: showVin && cachedVinBtns.includes(item.key)
        }, () => { void chrome.runtime.lastError; });
    });
}

function rebuildContextMenus() {
    chrome.storage.local.get(['os_context_menu_mode', 'os_hover_buttons', 'os_vin_hover_buttons'], (res) => {
        cachedMenuMode = res.os_context_menu_mode || 'submenu';
        cachedRegBtns = Array.isArray(res.os_hover_buttons)
            ? res.os_hover_buttons
            : ['search', 'bu-scrape', 'ci-direct', 'bu-direct'];
        cachedVinBtns = Array.isArray(res.os_vin_hover_buttons)
            ? res.os_vin_hover_buttons
            : ['etka', 'etkaweb', '7zap', 'partsouq', 'copy'];

        chrome.contextMenus.removeAll(() => {
            if (cachedMenuMode === 'direct') {
                chrome.contextMenus.create({ id: "bmg-search-reg", title: "Sök Fordon: '%s'", contexts: ["selection"] });
                chrome.contextMenus.create({ id: "bmg-scan-image", title: "Skanna Reg-nr från bild", contexts: ["image"] });
            } else {
                REG_MENU_ITEMS.forEach(item => {
                    chrome.contextMenus.create({
                        id: item.id,
                        title: item.title,
                        contexts: ["selection"],
                        visible: currentContextType === 'reg' && cachedRegBtns.includes(item.key)
                    });
                });

                VIN_MENU_ITEMS.forEach(item => {
                    chrome.contextMenus.create({
                        id: item.id,
                        title: item.title,
                        contexts: ["selection"],
                        visible: currentContextType === 'vin' && cachedVinBtns.includes(item.key)
                    });
                });

                chrome.contextMenus.create({ id: "bmg-scan-image", title: "🟠  Skanna Reg-nr från bild", contexts: ["image"] });
            }
        });
    });
}

chrome.runtime.onInstalled.addListener(rebuildContextMenus);
chrome.runtime.onStartup.addListener(rebuildContextMenus);

chrome.storage.onChanged.addListener((changes, ns) => {
    if (ns === 'local' && (changes.os_context_menu_mode || changes.os_hover_buttons || changes.os_vin_hover_buttons)) {
        rebuildContextMenus();
    }
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === "bmg-scan-image") {
        chrome.storage.local.set({ 'pending_image_scan': info.srcUrl }, openDropdownPopup);
        return;
    }

    const rawText = info.selectionText || lastRightClickVal || "";
    const cleanStr = rawText.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
    if (!cleanStr) return;

    // Kopiera automatiskt chassinumret till urklipp när man väljer ett VIN-alternativ via högerklick
    const copyToTabClipboard = (text) => {
        if (tab && tab.id) {
            chrome.scripting.executeScript({
                target: { tabId: tab.id },
                func: (v) => navigator.clipboard.writeText(v).catch(() => {}),
                args: [text]
            }).catch(() => {});
        }
    };

    if (info.menuItemId === "porsche-search-reg" || info.menuItemId === "vin-open-porsche") {
        if (cleanStr.length === 17) copyToTabClipboard(cleanStr);
        chrome.tabs.create({ url: `https://ph-veh-se03.cross.porscheinformatik.com/physical-vehicle/search?applicationName=SERVICE&conversation=1794303212235&prodFam=C3&q=${cleanStr.toLowerCase()}`, active: true });
        return;
    }

    // VIN-specifika val
    if (info.menuItemId === "vin-open-etka") {
        copyToTabClipboard(cleanStr);
        chrome.tabs.create({ url: 'https://superetka.com/etka/', active: true });
        return;
    } else if (info.menuItemId === "vin-open-etkaweb") {
        copyToTabClipboard(cleanStr);
        chrome.tabs.create({ url: 'https://www.etka.com/etkaweb/', active: true });
        return;
    } else if (info.menuItemId === "vin-open-7zap") {
        copyToTabClipboard(cleanStr);
        chrome.tabs.create({ url: `https://7zap.com/en/search/?q=${cleanStr}`, active: true });
        return;
    } else if (info.menuItemId === "vin-open-partsouq") {
        copyToTabClipboard(cleanStr);
        chrome.tabs.create({ url: `https://partsouq.com/en/search/all?q=${cleanStr}`, active: true });
        return;
    }

    // Reg-nr val
    if (cleanStr.length < 4 || cleanStr.length > 6) return;

    if (info.menuItemId === "bmg-search-reg") {
        chrome.storage.local.set({ 'pending_context_search': cleanStr }, openDropdownPopup);
    } else if (info.menuItemId === "bmg-search-bu") {
        chrome.storage.local.set({ 'pending_context_search': cleanStr, 'pending_context_engine': 'bu' }, openDropdownPopup);
    } else if (info.menuItemId === "open-ci-direct") {
        chrome.tabs.create({ url: `https://www.car.info/sv-se/license-plate/S/${cleanStr}`, active: true });
    } else if (info.menuItemId === "open-bu-direct") {
        chrome.tabs.create({ url: `https://biluppgifter.se/fordon/${cleanStr}`, active: true });
    }
});

function openDropdownPopup() {
    if (isMobile) {
        chrome.tabs.create({ url: chrome.runtime.getURL("popup.html"), active: true });
    } else {
        if (chrome.action && chrome.action.openPopup) {
            chrome.action.openPopup().catch(() => {
                chrome.windows.create({ url: chrome.runtime.getURL("popup.html"), type: 'popup', width: 420, height: 650, focused: true });
            });
        } else {
            chrome.windows.create({ url: chrome.runtime.getURL("popup.html"), type: 'popup', width: 420, height: 650, focused: true });
        }
    }
}
