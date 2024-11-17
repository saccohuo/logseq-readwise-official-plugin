import "@logseq/libs"
import "virtual:windi.css"

import React from "react"
import App from "./App"
import Font from "./icomoon.woff";
import {format} from 'date-fns'

import {logseq as PL} from "../package.json"
import {triggerIconName} from "./utils"
import {IBatchBlock, PageEntity, SettingSchemaDesc} from "@logseq/libs/dist/LSPlugin"
import {createRoot} from "react-dom/client";

// @ts-expect-error
const css = (t, ...args) => String.raw(t, ...args)
const magicKey = `__${PL.id}__loaded__`
// @ts-ignore
const partial = (func, ...args) => (...rest) => func(...args, ...rest);

export const isDev = process.env.NODE_ENV === "development"
export const baseURL = isDev ? "https://local.readwise.io:8000" : "https://readwise.io"
export const parentPageName = "Readwise"

interface ReadwiseBlock {
    string?: string;
    children?: Array<ReadwiseBlock>;
    title?: string;
    content?: string;
    author?: string;
    link?: string;
    tags?: string[];
    summary?: string;
}

interface ExportRequestResponse {
    latest_id: number,
    status: string
}

interface ExportStatusResponse {
    totalBooks: number,
    booksExported: number,
    isFinished: boolean,
    taskStatus: string,
}

async function delay(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function getLogseqClientID() {
    let clientId = window.localStorage.getItem('rw-LogseqClientId')
    if (clientId) {
        return clientId
    } else {
        clientId = Math.random().toString(36).substring(2, 15)
        window.localStorage.setItem('rw-LogseqClientId', clientId)
        return clientId
    }
}

// @ts-ignore
export async function getUserAuthToken(attempt = 0) {
    const uuid = getLogseqClientID()
    if (attempt === 0) {
        window.open(`${baseURL}/api_auth?token=${uuid}&service=logseq`)
    }
    await delay(2000)
    let response, data
    try {
        response = await window.fetch(
            `${baseURL}/api/auth?token=${uuid}`
        )
    } catch (e) {
        console.log("Readwise Official plugin: fetch failed in getUserAuthToken: ", e)
    }
    if (response && response.ok) {
        data = await response.json()
    } else {
        console.log("Readwise Official plugin: bad response in getUserAuthToken: ", response)
        logseq.App.showMsg('Authorization failed. Try again', 'warning')
        return
    }
    if (data.userAccessToken) {
        return data.userAccessToken
    } else {
        if (attempt > 20) {
            console.log('Readwise Official plugin: reached attempt limit in getUserAuthToken')
            return
        }
        console.log(`Readwise Official plugin: didn't get token data, retrying (attempt ${attempt + 1})`)
        await delay(1000)
        return await getUserAuthToken(attempt + 1)
    }
}

function processBlockContent(content: string, preferredDateFormat: string) {
    const reg = new RegExp(/timestamp:\|([0-9]+)\|/i)
    if (content !== undefined) {
        return content
            .replaceAll(/\n(\s*)-/smg, '\n$1\\-')
            .replace(reg, function (match, timestamp) {
                try {
                    return format(new Date(parseInt(timestamp)), preferredDateFormat)
                } catch (e) {
                    return ""
                }
            })
    } else {
        return content
    }
}

// Add this helper function to validate block content
function sanitizeBlockContent(content: string): string {
    // Remove any null bytes or invalid characters
    return content
        .replace(/\0/g, '')
        // Replace multiple newlines with single newline
        .replace(/\n{3,}/g, '\n\n')
        // Ensure proper markdown list formatting
        .replace(/^\s*[-*]\s*/gm, '- ')
        // Remove any zero-width spaces
        .replace(/[\u200B-\u200D\uFEFF]/g, '')
        // Ensure content doesn't start with whitespace
        .trim();
}

// Modify convertReadwiseToIBatchBlock function
function convertReadwiseToIBatchBlock(preferredDateFormat: string, obj: ReadwiseBlock) {
    try {
        console.log("[Convert] Input object:", obj);
        
        // 检查是否有 children
        if (obj.children && obj.children.length > 0) {
            const firstChild = obj.children[0];
            
            // 如果是新的 highlight (包含 "New highlights added")
            if (firstChild.string && firstChild.string.includes('New highlights added')) {
                console.log("[Convert] Found new highlights block");
                
                // 创建新的 highlights block
                const blocks: Array<IBatchBlock> = [{
                    content: processBlockContent(firstChild.string, preferredDateFormat)
                }];

                // 处理新的 highlights
                if (firstChild.children && firstChild.children.length > 0) {
                    console.log("[Convert] Processing new highlights");
                    const validChildren = firstChild.children.map(child => ({
                        content: sanitizeBlockContent(processBlockContent(child.string || '', preferredDateFormat) || '')
                    }));
                    blocks[0].children = validChildren;
                }

                console.log("[Convert] Final blocks:", blocks);
                return blocks;
            }
            
            // 原有的处理逻辑保持不变
            if (firstChild.string && firstChild.string.includes(':PROPERTIES:')) {
                console.log("[Convert] Found header block in first child");
                
                // 创建 blocks 数组，以 header block 开始
                const blocks: Array<IBatchBlock> = [{
                    content: firstChild.string
                }];

                // 处理其他 children 作为普通块
                const remainingChildren = obj.children.slice(1);
                if (remainingChildren.length > 0) {
                    console.log("[Convert] Processing remaining children");
                    
                    const validChildren = remainingChildren
                        .map(child => {
                            if (!child.string) return undefined;
                            const block: IBatchBlock = {
                                content: sanitizeBlockContent(processBlockContent(child.string, preferredDateFormat) || '')
                            };
                            if (child.children && child.children.length > 0) {
                                block.children = child.children.map(c => ({
                                    content: sanitizeBlockContent(processBlockContent(c.string || '', preferredDateFormat) || '')
                                }));
                            }
                            return block;
                        })
                        .filter((b): b is IBatchBlock => 
                            b !== undefined && 
                            typeof b.content === 'string' && 
                            b.content.length > 0
                        );

                    blocks.push(...validChildren);
                }

                console.log("[Convert] Final blocks:", blocks);
                return blocks;
            }
        }

        console.log("[Convert] No valid block found");
        return undefined;
    } catch (error) {
        console.error("[Convert] Error in convertReadwiseToIBatchBlock:", error);
        return undefined;
    }
}

// Modify createPage function
async function createPage(title: string, blocks: Array<IBatchBlock>) {
    try {
        console.log(`[CreatePage] Starting to create page: ${title}`);
        console.log(`[CreatePage] Blocks to create:`, blocks);

        if (!blocks || blocks.length === 0) {
            console.log("[CreatePage] No blocks provided");
            return false;
        }

        // 第一个块应该是 header block
        const headerBlock = blocks[0];
        if (!headerBlock || !headerBlock.content || !headerBlock.content.includes(':PROPERTIES:')) {
            console.log("[CreatePage] First block is not a valid header block");
            return false;
        }

        // Create the page with header block as first block
        const page = await logseq.Editor.createPage(title, undefined, {
            createFirstBlock: true,
            redirect: false
        });

        if (!page) {
            console.log(`[CreatePage] Failed to create page: ${title}`);
            return false;
        }

        console.log(`[CreatePage] Page created successfully:`, page);
        await delay(500);

        // Get the first block and update it with header content
        const pageBlocks = await logseq.Editor.getPageBlocksTree(page.name);
        if (!pageBlocks || pageBlocks.length === 0) {
            console.log(`[CreatePage] No blocks found in page after creation`);
            return false;
        }

        const firstBlock = pageBlocks[0];
        console.log(`[CreatePage] Updating first block with header content`);
        await logseq.Editor.updateBlock(firstBlock.uuid, headerBlock.content);
        await delay(100);

        // Get remaining blocks (all blocks after the header)
        const remainingBlocks = blocks.slice(1);
        console.log(`[CreatePage] Inserting ${remainingBlocks.length} remaining blocks`);
        
        for (const block of remainingBlocks) {
            const insertedBlock = await logseq.Editor.insertBlock(
                firstBlock.uuid,
                block.content,
                {
                    sibling: true,
                    before: false
                }
            );

            if (insertedBlock && block.children && block.children.length > 0) {
                await logseq.Editor.insertBatchBlock(
                    insertedBlock.uuid,
                    block.children,
                    {
                        sibling: false,
                        before: false,
                        keepUUID: true
                    }
                );
            }
            await delay(100);
        }

        // Verify final content
        const finalBlocks = await logseq.Editor.getPageBlocksTree(page.name);
        console.log(`[CreatePage] Final blocks count: ${finalBlocks.length}`);
        console.log(`[CreatePage] Final blocks:`, finalBlocks);

        return page;
    } catch (error) {
        console.error("[CreatePage] Error:", error);
        return false;
    }
}

// Modify updatePage function
async function updatePage(page: PageEntity, blocks: Array<IBatchBlock>) {
    try {
        console.log(`[UpdatePage] Starting update for page: ${page.name}`);
        console.log(`[UpdatePage] Blocks to update:`, blocks);
        
        // 检查是否是新的 highlights
        const isNewHighlights = blocks[0]?.content.includes('New highlights added');
        if (isNewHighlights) {
            console.log(`[UpdatePage] Processing new highlights`);
            
            // 找到最后一个 highlights block 或创建新的
            const pageBlocks = await logseq.Editor.getPageBlocksTree(page.uuid);
            let lastHighlightsBlock = pageBlocks
                .reverse()
                .find(b => b.content.includes('Highlights first synced by [[Readwise]]') ||
                          b.content.includes('New highlights added'));

            if (!lastHighlightsBlock) {
                console.log(`[UpdatePage] No highlights block found, creating new one`);
                const newBlock = await logseq.Editor.insertBlock(
                    page.uuid,
                    blocks[0].content,
                    { sibling: true }
                );
                if (newBlock) {
                    lastHighlightsBlock = newBlock;
                    console.log(`[UpdatePage] Created new highlights block:`, newBlock);
                } else {
                    console.log(`[UpdatePage] Failed to create highlights block`);
                    return;
                }
            }

            // 插入新的 highlights
            if (blocks[0].children && blocks[0].children.length > 0) {
                console.log(`[UpdatePage] Processing ${blocks[0].children.length} highlights`);
                for (const child of blocks[0].children) {
                    console.log(`[UpdatePage] Processing highlight:`, child);
                    const blockId = extractBlockId(child.content);
                    if (blockId) {
                        console.log(`[UpdatePage] Found block ID: ${blockId}`);
                        // 删除已存在的相同 ID 的 block
                        await findAndDeleteBlockById(page.uuid, blockId);
                    }
                    
                    if (lastHighlightsBlock) {
                        // 插入新的 block
                        console.log(`[UpdatePage] Inserting new highlight under:`, lastHighlightsBlock.uuid);
                        const newBlock = await logseq.Editor.insertBlock(
                            lastHighlightsBlock.uuid,
                            child.content,
                            { sibling: false }
                        );

                        if (newBlock) {
                            console.log(`[UpdatePage] Successfully inserted highlight:`, newBlock.uuid);
                        } else {
                            console.log(`[UpdatePage] Failed to insert highlight`);
                        }
                    }
                    await delay(100);
                }
            } else {
                console.log(`[UpdatePage] No highlights to process`);
            }
            
            console.log(`[UpdatePage] Successfully updated page with new highlights: ${page.name}`);
            return;
        }
        
        console.log(`[UpdatePage] Successfully updated page: ${page.name}`);
    } catch (error) {
        console.error(`[UpdatePage] Error updating page ${page.name}:`, error);
        logseq.App.showMsg(`Error updating "${page.originalName}"`, "error");
    }
}

function checkAndMigrateBooksIDsMap() {
    // check booksIDsMap format and migrate old format
    console.log("Readwise Official plugin: checking booksIDsMap format")
    if (logseq.settings!.booksIDsMap) {
        const booksIDsMap = logseq.settings!.booksIDsMap || {}
        const newBooksIDsMap = logseq.settings!.newBooksIDsMap || {}
        let isOldFormat = false
        if (Object.keys(booksIDsMap).length > Object.keys(newBooksIDsMap).length) {
            isOldFormat = true
        }
        if (isOldFormat) {
            console.log("Readwise Official plugin: migrating booksIDsMap format")
            const newBooksIDsMap: any = {}
            Promise.all(Object.keys(booksIDsMap).map((bookTitle) => {
                return new Promise((resolve) => {
                    logseq.Editor.getPage(bookTitle).then((page) => {
                        if (page) {
                            const bookId = booksIDsMap[bookTitle]
                            if (bookId) {
                                console.log(`Readwise Official plugin: migrating book ${bookTitle} (${bookId})`)
                                newBooksIDsMap[bookId] = page!.uuid
                                resolve(bookId)
                            }
                        }
                    })
                })
            })).then(() => {
                // @ts-ignore
                console.log("Readwise Official plugin: saving new booksIDsMap format (newBooksIDsMap setting)")
                logseq.updateSettings({newBooksIDsMap: null})
                logseq.updateSettings({
                    newBooksIDsMap: newBooksIDsMap
                })
            })
        } else {
            console.log("Readwise Official plugin: booksIDsMap format is correct")
        }
    } else {
        console.log("Readwise Official plugin: no booksIDsMap found, so new format is used")
    }

}

function getErrorMessageFromResponse(response: Response) {
    if (response && response.status === 409) {
        return "Sync in progress initiated by different client"
    }
    if (response && response.status === 417) {
        return "Logseq export is locked. Wait for an hour."
    }
    return `${response ? response.statusText : "Can't connect to server"}`
}

function getAuthHeaders() {
    return {
        'AUTHORIZATION': `Token ${logseq.settings!.readwiseAccessToken}`,
        'Logseq-Client': `${getLogseqClientID()}`
    }
}

function handleSyncError(notificationCallback: () => void) {
    clearSettingsAfterRun()
    logseq.updateSettings({
        lastSyncFailed: true
    })
    notificationCallback()
}

function clearSettingsAfterRun() {
    logseq.updateSettings({
        currentSyncStatusID: 0
    })
}

export function clearSettingsComplete() {
    logseq.updateSettings({
        currentSyncStatusID: 0,
        lastSyncFailed: false,
        lastSavedStatusID: 0,
        booksIDsMap: null,
        newBooksIDsMap: null,
        readwiseAccessToken: null,
        isLoadAuto: true,
        isResyncDeleted: false,
        currentGraph: null
    })
}

function handleSyncSuccess(msg = "Synced", exportID?: number) {
    clearSettingsAfterRun()
    logseq.updateSettings({
        lastSyncFailed: false,
        currentSyncStatusID: 0
    })
    if (exportID) {
        logseq.updateSettings({
            lastSavedStatusID: exportID
        })
    }
    logseq.App.showMsg(msg)
}

type BookToExport = [number, string]

async function refreshBookExport(books: Array<BookToExport>) {
    let response, bookIds: string[]
    if (books.length > 0) {
        try {
            bookIds = books.map((b) => b[1])
            response = await window.fetch(
                `${baseURL}/api/refresh_book_export`, {
                    headers: {...getAuthHeaders(), 'Content-Type': 'application/json'},
                    method: "POST",
                    body: JSON.stringify({exportTarget: 'logseq', books: bookIds})
                }
            )
        } catch (e) {
            console.log("Readwise Official plugin: fetch failed in refreshBookExport: ", e);
        }
        if (response && response.ok) {
            const booksIDsMap = logseq.settings!.newBooksIDsMap || {}
            const booksIDsMapAsArray = Object.entries(booksIDsMap)
            logseq.updateSettings({newBooksIDsMap: null}) // bug: https://github.com/logseq/logseq/issues/4447
            logseq.updateSettings({
                newBooksIDsMap: Object.fromEntries(booksIDsMapAsArray.filter((b) => !bookIds.includes(b[0])))
            })
        }
    } else {
        console.log("Skipping refresh, no books")
    }
}

async function acknowledgeSyncCompleted() {
    let response
    try {
        response = await window.fetch(
            `${baseURL}/api/logseq/sync_ack`,
            {
                headers: {...getAuthHeaders(), 'Content-Type': 'application/json'},
                method: "POST",
            })
    } catch (e) {
        console.log("Readwise Official plugin: fetch failed to acknowledged sync: ", e)
    }
    if (response && response.ok) {
        return
    } else {
        console.log("Readwise Official plugin: bad response in acknowledge sync: ", response)
        logseq.App.showMsg(getErrorMessageFromResponse(response as Response), "error")
        return
    }
}

// Helper function to extract block ID from content
function extractBlockId(content: string): string | null {
    // For org-mode format
    const orgIdMatch = content.match(/:id:\s*([a-f0-9-]+)/i);
    if (orgIdMatch) {
        return orgIdMatch[1];
    }
    return null;
}

// Helper function to find block by ID in a page
async function findBlockByReadwiseId(pageUUID: string, readwiseId: string): Promise<any | null> {
    console.log(`[FindBlock] Searching for block with ID: ${readwiseId} in page: ${pageUUID}`);
    const blocks = await logseq.Editor.getPageBlocksTree(pageUUID);
    
    for (const block of blocks) {
        const blockId = extractBlockId(block.content);
        if (blockId === readwiseId) {
            console.log(`[FindBlock] Found block:`, block);
            return block;
        }
        
        // Search in children if they exist
        if (block.children) {
            for (const child of block.children) {
                const childId = extractBlockId(child.content);
                if (childId === readwiseId) {
                    console.log(`[FindBlock] Found block in children:`, child);
                    return child;
                }
            }
        }
    }
    
    console.log(`[FindBlock] No block found with ID: ${readwiseId}`);
    return null;
}

// Helper function to update existing block
async function updateExistingBlock(block: any, newContent: string): Promise<boolean> {
    try {
        console.log(`[UpdateBlock] Updating block ${block.uuid} with new content`);
        await logseq.Editor.updateBlock(block.uuid, newContent);
        return true;
    } catch (error) {
        console.error(`[UpdateBlock] Error updating block:`, error);
        return false;
    }
}

// Helper function to find header block
async function findHeaderBlock(pageUUID: string): Promise<any | null> {
    console.log(`[FindHeader] Looking for header block in page: ${pageUUID}`);
    const blocks = await logseq.Editor.getPageBlocksTree(pageUUID);
    
    // Find the first block that contains PROPERTIES
    for (const block of blocks) {
        if (block.content && block.content.includes(':PROPERTIES:')) {
            console.log(`[FindHeader] Found header block:`, block);
            return block;
        }
    }
    
    console.log(`[FindHeader] No header block found`);
    return null;
}

// Helper function to insert block after header
async function insertBlockAfterHeader(pageUUID: string, content: string, headerBlock: any): Promise<any> {
    try {
        console.log(`[InsertBlock] Inserting block after header`);
        const newBlock = await logseq.Editor.insertBlock(
            headerBlock.uuid,
            content,
            {
                sibling: true,
                before: false
            }
        );
        return newBlock;
    } catch (error) {
        console.error(`[InsertBlock] Error inserting block:`, error);
        return null;
    }
}

// @ts-ignore
async function downloadArchive(exportID: number, setNotification?, setIsSyncing?, auto?): Promise<void> {
    const artifactURL = `${baseURL}/api/download_artifact/${exportID}`
    if (exportID <= logseq.settings!.lastSavedStatusID) {
        console.log(`Readwise Official plugin: Already saved data from export ${exportID}`)
        handleSyncSuccess()
        logseq.App.showMsg("Readwise data is already up to date")
        setIsSyncing(false)
        return
    }

    let response
    try {
        response = await window.fetch(
            artifactURL, {headers: getAuthHeaders()}
        )
    } catch (e) {
        console.log("Readwise Official plugin: fetch failed in downloadArchive: ", e)
        setIsSyncing(false)
    }
    const booksIDsMap = logseq.settings!.newBooksIDsMap || {}
    const preferredDateFormat = (await logseq.App.getUserConfigs()).preferredDateFormat
    if (response && response.ok) {
        const responseJSON = await response.json()
        console.log("[DownloadArchive] Response JSON:", responseJSON);
        const books = responseJSON.books
        if (books.length) {
            setNotification("Saving pages...")
            for (const [index, book] of books.entries()) {
                const bookId = book.userBookExportId
                const bookIsUpdate = book.isUpdate
                const bookData = book.data
                console.log("[DownloadArchive] Processing book:", {
                    bookId,
                    bookIsUpdate,
                    title: bookData.title
                });

                const localId = booksIDsMap[bookId]
                console.log("[DownloadArchive] Local ID from booksIDsMap:", localId);

                let page = null
                if (localId) {
                    page = await logseq.Editor.getPage(localId)
                    console.log("[DownloadArchive] Found existing page:", page);
                }

                const convertedBook = convertReadwiseToIBatchBlock(preferredDateFormat, bookData)
                console.log("[DownloadArchive] Converted book data:", convertedBook);

                if (bookIsUpdate) {
                    if (page !== null) {
                        try {
                            console.log(`[DownloadArchive] Processing update for book: ${bookData.title}`);
                            
                            if (convertedBook !== undefined) {
                                console.log(`[DownloadArchive] Starting update with converted data:`, convertedBook);
                                await updatePage(page, convertedBook);
                                setNotification(`Updated "${bookData.title}" (${index}/${books.length})`);
                            }
                        } catch (error) {
                            console.error("Error processing update for book:", bookData.title, error);
                            setNotification(`Error processing "${bookData.title}" (${index}/${books.length})`);
                            continue;
                        }
                    } else {
                        // If page is null but it's an update, try to find by title
                        console.log("[DownloadArchive] Page not found by ID, trying to find by title:", bookData.title);
                        const page_ = await logseq.Editor.getPage(bookData.title)
                        
                        if (page_ === null) {
                            // If page doesn't exist at all, create it and resync
                            console.log("[DownloadArchive] Page not found by title, creating new page and resyncing");
                            if (convertedBook !== undefined) {
                                setNotification(`Creating new "${bookData.title}" (${index}/${books.length})`);
                                const newPage = await createPage(bookData.title, convertedBook);
                                
                                if (newPage) {
                                    booksIDsMap[bookId] = newPage.uuid;
                                    // Request resync for this book
                                    const resyncSuccess = await resyncBookHighlights(bookId.toString());
                                    if (resyncSuccess) {
                                        setNotification(`Created page and requested resync for "${bookData.title}"`);
                                    } else {
                                        setNotification(`Created page but failed to resync "${bookData.title}"`);
                                    }
                                }
                            }
                        } else {
                            // Existing update logic for found page
                            console.log("[DownloadArchive] Found page by title, updating");
                            if (convertedBook !== undefined) {
                                await updatePage(page_, convertedBook);
                                booksIDsMap[bookId] = page_.uuid;
                                setNotification(`Updated "${bookData.title}" (${index}/${books.length})`);
                            }
                        }
                    }
                } else {
                    // Handle new books
                    if (convertedBook !== undefined) {
                        const existing_page = await logseq.Editor.getPage(bookData.title)
                        if (existing_page !== null) {
                            booksIDsMap[bookId] = existing_page.uuid;
                            setNotification(`Skipping "${bookData.title}" (already exists) (${index}/${books.length})`);
                        } else {
                            // Create new page
                            const newPage = await createPage(bookData.title, convertedBook);
                            if (newPage) {
                                booksIDsMap[bookId] = newPage.uuid;
                                setNotification(`Created "${bookData.title}" (${index}/${books.length})`);
                            }
                        }
                    }
                }
            }

            const readwisePage = await logseq.Editor.getPage(parentPageName)
            if (readwisePage === null) {
                await logseq.Editor.createPage(parentPageName, undefined, {
                    createFirstBlock: false,
                    redirect: false
                })
            }
            if (readwisePage && responseJSON.syncNotification) {
                console.log(`Updating ${parentPageName} page with sync notification`);
                const notificationContent = responseJSON.syncNotification.children?.[0]?.string;
                if (notificationContent) {
                    await logseq.Editor.insertBlock(
                        readwisePage.uuid,
                        processBlockContent(notificationContent, preferredDateFormat),
                        { sibling: true }
                    );
                }
            }
        }
        logseq.updateSettings({newBooksIDsMap: null}) // bug: https://github.com/logseq/logseq/issues/4447
        logseq.updateSettings({
            newBooksIDsMap: booksIDsMap
        })
        setIsSyncing(false)
        setNotification(null)
    } else {
        setIsSyncing(false)
        setNotification(null)
        console.log("Readwise Official plugin: bad response in downloadArchive: ", response)
        logseq.App.showMsg(getErrorMessageFromResponse(response as Response), "error")
        return
    }

    await acknowledgeSyncCompleted()
    handleSyncSuccess("Synced!", exportID)
    logseq.App.showMsg("Readwise sync completed")
    setIsSyncing(false)
    setNotification(null)
}

// @ts-ignore
async function getExportStatus(
    statusID?: number, 
    setNotification?, 
    setIsSyncing?, 
    auto?,
    currentAttempts: number = 0  // 添加计数器参数
) {
    const statusId = statusID || logseq.settings!.currentSyncStatusID
    const url = `${baseURL}/api/get_export_status?exportStatusId=${statusId}`
    let response, data: ExportStatusResponse
    const maxAttempts = 1000; // 最多等待60秒 (30次 * 2秒)

    console.log(`[GetExportStatus] Starting status check for ID: ${statusId} (attempt ${currentAttempts + 1}/${maxAttempts})`);

    try {
        response = await window.fetch(
            url,
            {
                headers: getAuthHeaders()
            }
        )
    } catch (e) {
        console.error("[GetExportStatus] Fetch failed:", e);
    }

    if (response && response.ok) {
        data = await response.json()
        console.log("[GetExportStatus] Status response:", data);
    } else {
        console.error("[GetExportStatus] Bad response:", response);
        logseq.App.showMsg(getErrorMessageFromResponse(response as Response), "error")
        return
    }

    const WAITING_STATUSES = ['PENDING', 'RECEIVED', 'STARTED', 'RETRY']
    const SUCCESS_STATUSES = ['SUCCESS']

    if (WAITING_STATUSES.includes(data.taskStatus)) {
        if (currentAttempts >= maxAttempts) {
            console.error("[GetExportStatus] Reached maximum attempts, timing out");
            setNotification(null);
            setIsSyncing(false);
            handleSyncError(() => {
                const msg = 'Sync timed out after 60 seconds';
                if (!auto) {
                    logseq.App.showMsg(msg, "error");
                } else {
                    console.log(msg);
                }
            });
            return;
        }

        if (data.booksExported) {
            console.log(`[GetExportStatus] Progress: ${data.booksExported} / ${data.totalBooks}`);
            setNotification(`Exporting Readwise data (${data.booksExported} / ${data.totalBooks}) ...`)
        } else {
            console.log("[GetExportStatus] Building export...");
            setNotification("Building export...")
        }

        // re-try in 2 secs with incremented attempt counter
        await delay(2000)
        return getExportStatus(statusId, setNotification, setIsSyncing, auto, currentAttempts + 1)
    } else if (SUCCESS_STATUSES.includes(data.taskStatus)) {
        console.log("[GetExportStatus] Export completed successfully");
        setNotification(null)
        return downloadArchive(statusId, setNotification, setIsSyncing, auto)
    } else {
        console.error("[GetExportStatus] Task failed with status:", data.taskStatus);
        setNotification(null)
        setIsSyncing(false)
        handleSyncError(() => {
            const msg = 'Sync failed'
            if (!auto) {
                logseq.App.showMsg(msg, "error")
            } else {
                console.log(msg)
            }
        })
    }
    setNotification(null)
    setIsSyncing(false)
}

function configureSchedule() {
    checkForCurrentGraph()
    // @ts-ignore
    const onAnotherGraph = window.onAnotherGraph
    if (logseq.settings!.readwiseAccessToken && logseq.settings!.frequency) {
        if (logseq.settings!.frequency === "Never") {
            return
        }
        if (!onAnotherGraph) {
            const frequency = parseInt(logseq.settings!.frequency)
            if (!isNaN(frequency) && frequency > 0) {
                const milliseconds = frequency * 60 * 1000
                // Set up interval for auto sync
                window.setInterval(() => {
                    syncHighlights(true, console.log, () => {})
                        .then(() => console.log('Auto sync loaded.'))
                        .catch(error => console.error('Auto sync error:', error));
                }, milliseconds);
            } else {
                // setting the default value on settings, for previous values
                logseq.updateSettings({
                    frequency: "60",
                })
            }
        }
    }
}


function resyncDeleted(callback: (() => void)) {
    checkForCurrentGraph()
    // @ts-ignore
    const onAnotherGraph = window.onAnotherGraph
    if (logseq.settings!.readwiseAccessToken && logseq.settings!.isResyncDeleted) {
        if (!onAnotherGraph) {
            (new Promise(r => setTimeout(r, 2000))).then(() => {
                    const booksIDsMap = logseq.settings!.newBooksIDsMap || {}
                    // @ts-ignore
                    Promise.all(Object.keys(booksIDsMap).map((userBookId) => {
                        return new Promise((resolve) => {
                            logseq.Editor.getPage(booksIDsMap[userBookId]).then((res) => {
                                if (res === null) {
                                    resolve(([booksIDsMap[userBookId], userBookId]))
                                    console.log(`Page UserBook ID: '${userBookId}' deleted, going to resync.`)
                                } else {
                                    resolve(null)
                                }
                            })
                        })
                    })).then(r => {
                        // @ts-ignore
                        refreshBookExport(r.filter(b => b !== null)).then(() => {
                            console.log('Resync deleted done.')
                        })
                    })

                }
            )
        }
    }
    (new Promise(r => setTimeout(r, 2000))).then(() => {
            callback()
        }
    )
}

// @ts-ignore
export async function syncHighlights(auto?: boolean, setNotification?, setIsSyncing?) {
    resyncDeleted(async () => {
        setNotification("Starting sync...")
        let url = `${baseURL}/api/logseq/init?auto=${auto}`
        if (auto) {
            await delay(4000)
        }
        const parentDeleted = await logseq.Editor.getPage(parentPageName) === null
        if (parentDeleted) {
            url += `&parentPageDeleted=${parentDeleted}`
        }
        url += `&lastSyncFailed=${logseq.settings!.lastSyncFailed}`
        let response, data: ExportRequestResponse
        try {
            response = await window.fetch(
                url,
                {
                    headers: getAuthHeaders()
                }
            )
        } catch (e) {
            console.log("Readwise Official plugin: fetch failed in requestArchive: ", e)
        }
        if (response && response.ok) {
            data = await response.json()
            if (data.latest_id <= logseq.settings!.lastSavedStatusID) {
                handleSyncSuccess()
                logseq.App.showMsg("Readwise data is already up to date")
                setIsSyncing(false)
                setNotification(null)
                return
            }
            logseq.updateSettings({
                currentSyncStatusID: data.latest_id
            })
            if (response.status === 201) {
                logseq.App.showMsg("Syncing Readwise data")
                return getExportStatus(data.latest_id, setNotification, setIsSyncing, auto)
            } else {
                setIsSyncing(false)
                setNotification(null)
                handleSyncSuccess("Synced", data.latest_id)
                logseq.App.showMsg("Latest Readwise sync already happened on your other device. Data should be up to date")
            }
        } else {
            console.log("Readwise Official plugin: bad response in requestArchive: ", response)
            logseq.App.showMsg(getErrorMessageFromResponse(response as Response), "error")
            setIsSyncing(false)
            setNotification(null)
            return
        }
        setIsSyncing(false)
        setNotification(null)
    })
}

export function checkForCurrentGraph() {
    window.logseq.App.getCurrentGraph().then((currentGraph) => {
        // @ts-ignore
        window.onAnotherGraph = !!(logseq.settings!.currentGraph && currentGraph?.url !== logseq.settings!.currentGraph.url);
    })
}

function main() {
    const schema: Array<SettingSchemaDesc> = [
        {
            key: "isLoadAuto",
            type: "boolean",
            default: true,
            title: "Sync automatically when Logseq opens",
            description: "If enabled, Readwise will automatically resync with Logseq each time you open the app",
        },
        {
            key: "isResyncDeleted",
            type: "boolean",
            default: false,
            title: "Resync deleted pages",
            description: "If enabled, you can refresh individual items by deleting the page in Logseq and initiating a resync",
        },
        {
            key: "frequency",
            type: "enum",
            enumChoices: ["15", "30", "60", "90", "Never"],
            enumPicker: "select",
            default: "60",
            title: "Resync frequency",
            description: "Readwise will automatically resync with Logseq when the app is open at the specified interval (in minutes)",
        }
    ]
    logseq.useSettingsSchema(schema)
    const pluginId = logseq.baseInfo.id
    console.info(`#${pluginId}: MAIN`)
    const container = document.getElementById('app')
    const root = createRoot(container!)
    root.render(
        <React.StrictMode>
            <App/>
        </React.StrictMode>
    )

    checkAndMigrateBooksIDsMap()

    function createModel() {
        return {
            async show() {
                logseq.showMainUI()
            },
        }
    }

    logseq.provideModel(createModel())
    logseq.setMainUIInlineStyle({
        zIndex: 11,
    })

    if (isDev) {
        // @ts-expect-error
        top[magicKey] = true
    }
    logseq.provideStyle(css`
      @font-face {
        font-family: 'readwise';
        src: url(${Font}) format('woff');
        font-weight: normal;
        font-style: normal;
        font-display: block;
      }

      [class^="rw-"], [class*=" rw-"] {
        font-family: 'readwise' !important;
        speak: never;
        font-style: normal;
        font-weight: normal;
        font-variant: normal;
        text-transform: none;
        line-height: 1;
        -webkit-font-smoothing: antialiased;
      }

      .${triggerIconName} {
        font-size: 20px;
      }

      .${triggerIconName}:before {
        content: "\e900";
      }
    `)

    logseq.App.registerUIItem("toolbar", {
        key: "readwise-plugin-open",
        template: `
          <a data-on-click="show" title="Readwise" class="button">
            <span class="${triggerIconName}">
            </span>
          </a>
        `,
    })

    if (logseq.settings!.currentSyncStatusID !== 0) {
        logseq.updateSettings({
            lastSyncFailed: true,
            currentSyncStatusID: 0
        })
    }

    // check current state
    if (logseq.settings!.readwiseAccessToken && logseq.settings!.currentSyncStatusID !== 0) {
        // the last sync didn't finish correctly (initial phase)
        (new Promise(r => setTimeout(r, 1000))).then(() => {
                logseq.App.showMsg("Readwise sync didn't finish correctly, please start a new sync again", "warning")
            }
        )
    }
    checkForCurrentGraph()
    window.logseq.App.onCurrentGraphChanged(() => {
        checkForCurrentGraph()
    })
    // @ts-ignore
    const onAnotherGraph = window.onAnotherGraph
    if (logseq.settings!.readwiseAccessToken && logseq.settings!.isLoadAuto) {
        if (!onAnotherGraph && logseq.settings!.currentSyncStatusID === 0) {
            // eslint-disable-next-line @typescript-eslint/no-empty-function
            syncHighlights(true, console.log, () => {
            }).then(() => console.log('Auto sync loaded.'))
        }
    } else {
        resyncDeleted(() => {
            console.log("Readwise Official plugin: resync deleted pages without auto sync")
        })
    }
    // we set an interval
    configureSchedule()
}

// @ts-expect-error
if (isDev && top[magicKey]) {
    // Currently there is no way to reload plugins
    location.reload()
} else {
    logseq.ready(main).catch(console.error)
}

async function resyncBookHighlights(bookId: string) {
    console.log(`[Resync] Requesting resync for book: ${bookId}`);
    try {
        const response = await window.fetch(
            `${baseURL}/api/refresh_book_export`,
            {
                headers: {...getAuthHeaders(), 'Content-Type': 'application/json'},
                method: "POST",
                body: JSON.stringify({
                    exportTarget: 'logseq',
                    books: [bookId]
                })
            }
        );
        if (response.ok) {
            console.log(`[Resync] Successfully requested resync for book: ${bookId}`);
            return true;
        }
    } catch (error) {
        console.error(`[Resync] Error requesting resync:`, error);
    }
    return false;
}

interface BlockWithId {
    uuid: string;
    content: string;
    id?: string;
}

async function findAndDeleteBlockById(pageUUID: string, blockId: string): Promise<boolean> {
    console.log(`[Delete] Looking for block with ID: ${blockId}`);
    try {
        const block = await findBlockByReadwiseId(pageUUID, blockId);
        if (block) {
            console.log(`[Delete] Found block to delete: ${block.uuid}`);
            
            // Get parent block before deleting
            const parentBlock = await logseq.Editor.getBlock(block.parent.id);
            if (!parentBlock) {
                console.log(`[Delete] Parent block not found`);
                return false;
            }

            // Delete the target block
            await logseq.Editor.removeBlock(block.uuid);
            console.log(`[Delete] Block deleted: ${block.uuid}`);

            // Check if parent is a "Highlights" block and has no other children
            if (parentBlock.content.includes('Highlights first synced by [[Readwise]]')) {
                const remainingChildren = await logseq.Editor.getBlockChildren(parentBlock.uuid);
                if (!remainingChildren || remainingChildren.length === 0) {
                    console.log(`[Delete] Parent block has no more children, deleting parent: ${parentBlock.uuid}`);
                    await logseq.Editor.removeBlock(parentBlock.uuid);
                } else {
                    console.log(`[Delete] Parent block still has ${remainingChildren.length} children, keeping parent`);
                }
            }

            return true;
        }
        return false;
    } catch (error) {
        console.error(`[Delete] Error deleting block:`, error);
        return false;
    }
}

// Helper function to check if a block has children
async function hasChildren(blockUUID: string): Promise<boolean> {
    try {
        const children = await logseq.Editor.getBlockChildren(blockUUID);
        return children && children.length > 0;
    } catch (error) {
        console.error(`[HasChildren] Error checking children:`, error);
        return false;
    }
}

async function handleHighlightUpdate(page: PageEntity, block: IBatchBlock): Promise<boolean> {
    const blockId = extractBlockId(block.content);
    if (!blockId) {
        console.log(`[Update] No ID found in block content`);
        return false;
    }

    // Delete existing block with same ID
    await findAndDeleteBlockById(page.uuid, blockId);

    // Find the latest sync header block (either "Highlights first synced" or "New highlights added")
    const pageBlocks = await logseq.Editor.getPageBlocksTree(page.uuid);
    let syncBlock = pageBlocks
        .reverse()
        .find(b => b.content.includes('Highlights first synced by [[Readwise]]') || 
                   b.content.includes('New highlights added'));

    // Insert new block under sync block
    if (syncBlock) {
        const newBlock = await logseq.Editor.insertBlock(
            syncBlock.uuid,
            block.content,
            { sibling: false }
        );

        if (newBlock && block.children) {
            await logseq.Editor.insertBatchBlock(
                newBlock.uuid,
                block.children,
                {
                    sibling: false,
                    before: false,
                    keepUUID: true
                }
            );
        }
        return true;
    }

    // If no sync block found, just add under the header block
    const headerBlock = await findHeaderBlock(page.uuid);
    if (headerBlock) {
        const newBlock = await logseq.Editor.insertBlock(
            headerBlock.uuid,
            block.content,
            { sibling: true }
        );

        if (newBlock && block.children) {
            await logseq.Editor.insertBatchBlock(
                newBlock.uuid,
                block.children,
                {
                    sibling: false,
                    before: false,
                    keepUUID: true
                }
            );
        }
        return true;
    }

    return false;
}

interface ConflictNotification {
    blockId: string;
    oldContent: string;
    newContent: string;
    pageTitle: string;
}

let conflictNotifications: ConflictNotification[] = [];

async function checkForIdConflict(pageUUID: string, blockId: string, newContent: string): Promise<boolean> {
    const existingBlock = await findBlockByReadwiseId(pageUUID, blockId);
    if (existingBlock && existingBlock.content !== newContent) {
        console.log(`[Conflict] Found ID conflict for block: ${blockId}`);
        conflictNotifications.push({
            blockId,
            oldContent: existingBlock.content,
            newContent,
            pageTitle: (await logseq.Editor.getPage(pageUUID))?.originalName || ''
        });
        return true;
    }
    return false;
}

// 在 App.tsx 中添加冲突通知组件
function ConflictNotification({ conflicts, onResolve }) {
    if (conflicts.length === 0) return null;

    return (
        <div className="conflict-notification">
            <h3>Content Conflicts Detected</h3>
            {conflicts.map((conflict, index) => (
                <div key={index} className="conflict-item">
                    <p>Page: {conflict.pageTitle}</p>
                    <p>Old content: {conflict.oldContent}</p>
                    <p>New content: {conflict.newContent}</p>
                    <button onClick={() => onResolve(index)}>Resolve</button>
                </div>
            ))}
        </div>
    );
}
