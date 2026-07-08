const Database = window.__TAURI__.sql;
const db = await Database.load("sqlite:inventory.db");

// Additive-only schema handling: tables are created once, and any future column
// additions are patched in with ALTER TABLE ADD COLUMN. Existing rows are NEVER
// renamed, rebuilt, or copied — your data survives every future code update.
async function ensureInventoryTable() {
    await db.execute(`
        CREATE TABLE IF NOT EXISTS inventory (
            control_number INTEGER PRIMARY KEY AUTOINCREMENT,
            product_type TEXT,
            price REAL,
            cost REAL DEFAULT 0,
            profit REAL DEFAULT 0,
            date TEXT
        )
    `);

    await db.execute(`
        CREATE TABLE IF NOT EXISTS sold_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            control_number INTEGER,
            product_type TEXT,
            price REAL,
            cost REAL DEFAULT 0,
            profit REAL DEFAULT 0,
            date_added TEXT,
            date_sold TEXT
        )
    `);

    // If the tables already existed from an older version of the app, patch in
    // any columns that are missing. Nothing here can ever delete or move data.
    await addMissingColumns("inventory", [
        { name: "product_type", type: "TEXT" },
        { name: "price", type: "REAL" },
        { name: "cost", type: "REAL DEFAULT 0" },
        { name: "profit", type: "REAL DEFAULT 0" },
        { name: "date", type: "TEXT" }
    ]);

    await addMissingColumns("sold_items", [
        { name: "control_number", type: "INTEGER" },
        { name: "product_type", type: "TEXT" },
        { name: "price", type: "REAL" },
        { name: "cost", type: "REAL DEFAULT 0" },
        { name: "profit", type: "REAL DEFAULT 0" },
        { name: "date_added", type: "TEXT" },
        { name: "date_sold", type: "TEXT" },
        { name: "original_price", type: "REAL DEFAULT 0" },
        { name: "discount_type", type: "TEXT DEFAULT 'none'" },
        { name: "discount_value", type: "REAL DEFAULT 0" },
        { name: "discount_amount", type: "REAL DEFAULT 0" }
    ]);
}

async function addMissingColumns(tableName, expectedColumns) {
    const existingColumns = await db.select(`PRAGMA table_info(${tableName})`);
    const existingNames = existingColumns.map(c => c.name);

    for (const col of expectedColumns) {
        if (!existingNames.includes(col.name)) {
            await db.execute(`ALTER TABLE ${tableName} ADD COLUMN ${col.name} ${col.type}`);
            console.info(`Added missing column "${col.name}" to "${tableName}" — existing rows kept intact.`);
        }
    }
}

await ensureInventoryTable();

const loginScreen = document.querySelector("#login-screen");
const appLayout = document.querySelector("#app-layout");
const loginForm = document.querySelector("#login-form");
const loginError = document.querySelector("#login-error");
const logoutBtn = document.querySelector("#logout-btn");
const navBtns = document.querySelectorAll(".nav-btn");
const views = document.querySelectorAll(".view");

const addModalOverlay = document.querySelector("#add-modal-overlay");
const openAddModalBtn = document.querySelector("#open-add-modal");
const closeAddModalBtn = document.querySelector("#close-add-modal");
const cancelAddModalBtn = document.querySelector("#cancel-add-modal");
const itemForm = document.querySelector("#item-form");
const inventoryTableBody = document.querySelector("#inventory-list");
const emptyState = document.querySelector("#empty-state");
const modalTitle = document.querySelector("#modal-title");
const saveItemBtn = document.querySelector("#save-item-btn");
const sortableHeaders = document.querySelectorAll("#inventory-table th[data-sort]");
const qtyFieldWrapper = document.querySelector("#qty-field-wrapper");
const productTypeSelect = document.querySelector("#filter-product-type");
const dateRangeSelect = document.querySelector("#filter-date-range");
const customDateFieldsWrapper = document.querySelector("#custom-date-fields");
const dateFromInput = document.querySelector("#filter-date-from");
const dateToInput = document.querySelector("#filter-date-to");

const soldModalOverlay = document.querySelector("#sold-modal-overlay");
const openSoldModalBtn = document.querySelector("#open-sold-modal");
const closeSoldModalBtn = document.querySelector("#close-sold-modal");
const cancelSoldModalBtn = document.querySelector("#cancel-sold-modal");
const cancelSoldConfirmBtn = document.querySelector("#cancel-sold-confirm-btn");
const findSoldItemBtn = document.querySelector("#find-sold-item-btn");
const confirmSoldBtn = document.querySelector("#confirm-sold-btn");
const soldControlNumberInput = document.querySelector("#sold-control-number");
const soldLookupError = document.querySelector("#sold-lookup-error");
const soldLookupStep = document.querySelector("#sold-lookup-step");
const soldConfirmStep = document.querySelector("#sold-confirm-step");
const soldDiscountType = document.querySelector("#sold-discount-type");
const soldDiscountValue = document.querySelector("#sold-discount-value");
const soldDetailFinalPrice = document.querySelector("#sold-detail-final-price");

// Dashboard elements
const soldTableBody = document.querySelector("#sold-list");
const soldEmptyState = document.querySelector("#sold-empty-state");
const salesTrendCanvas = document.querySelector("#sales-trend-chart");
let salesTrendChart = null; // Chart.js instance, recreated each time the dashboard loads

// Home elements
const homeOpenAddModalBtn = document.querySelector("#home-open-add-modal");
const homeOpenSoldModalBtn = document.querySelector("#home-open-sold-modal");
const homeDateSubtitle = document.querySelector("#home-date-subtitle");
const homeStatStock = document.querySelector("#home-stat-stock");
const homeStatSoldMonth = document.querySelector("#home-stat-sold-month");
const homeStatSoldMonthSub = document.querySelector("#home-stat-sold-month-sub");
const homeStatProfitMonth = document.querySelector("#home-stat-profit-month");
const homeStatProfitTrend = document.querySelector("#home-stat-profit-trend");
const homePopularItem = document.querySelector("#home-popular-item");
const homePopularItemSub = document.querySelector("#home-popular-item-sub");
const homePopularityCanvas = document.querySelector("#home-popularity-chart");
const homeProfitTrendCanvas = document.querySelector("#home-profit-trend-chart");
const homeActivityList = document.querySelector("#home-activity-list");
const homeActivityEmpty = document.querySelector("#home-activity-empty");
let homePopularityChart = null;
let homeProfitTrendChart = null;

const CHART_PALETTE = ["#c9a24a", "#1e293b", "#9c6b30", "#6b8fae", "#a3a3a3", "#8a4f6b"];

// Holds the item currently pending sale confirmation.
let pendingSoldItem = null;

// Tracks which control_number is currently being edited.
// null means the modal is in "add new item" mode.
let editingControlNumber = null;

// Keeps the last-loaded items in memory so sorting/filtering doesn't need to re-query the DB.
let currentItems = [];
// Default: sort by control_number, highest first.
let sortState = { column: "control_number", direction: "desc" };

// ---------- Login ----------
loginForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const user = document.querySelector("#username").value;
    const pass = document.querySelector("#password").value;

    if (user === "admin" && pass === "admin123") {
        loginError.textContent = "";
        loginForm.reset();
        loginScreen.classList.add("hidden");
        appLayout.classList.remove("hidden");
        loadItems();
        loadHome();
    } else {
        loginError.textContent = "Invalid username or password.";
    }
});

logoutBtn.addEventListener("click", () => {
    appLayout.classList.add("hidden");
    loginScreen.classList.remove("hidden");
});

// ---------- Navigation ----------
navBtns.forEach(btn => {
    btn.addEventListener("click", (e) => {
        const target = e.currentTarget;
        navBtns.forEach(b => b.classList.remove("active"));
        target.classList.add("active");

        views.forEach(v => v.classList.add("hidden"));
        document.getElementById(target.dataset.target).classList.remove("hidden");

        if (target.dataset.target === "dashboard-view") {
            loadDashboard();
        }
        if (target.dataset.target === "home-view") {
            loadHome();
        }
    });
});

// Quick actions on the Home screen reuse the same modals as the Inventory view.
homeOpenAddModalBtn.addEventListener("click", openAddModal);
homeOpenSoldModalBtn.addEventListener("click", openSoldModal);

// ---------- Add / Edit Product Modal ----------
function openAddModal() {
    editingControlNumber = null;
    modalTitle.textContent = "Add Product";
    saveItemBtn.textContent = "Save Item";
    itemForm.reset();
    document.querySelector("#item-qty").value = 1;
    qtyFieldWrapper.classList.remove("hidden");
    document.querySelector("#item-qty").required = true;
    addModalOverlay.classList.remove("hidden");
    document.querySelector("#item-type").focus();
}

function openEditModal(item) {
    editingControlNumber = item.control_number;
    modalTitle.textContent = "Edit Product";
    saveItemBtn.textContent = "Update Item";

    // Editing acts on a single existing unit, so quantity doesn't apply here.
    qtyFieldWrapper.classList.add("hidden");
    document.querySelector("#item-qty").required = false;

    document.querySelector("#item-type").value = item.product_type;
    document.querySelector("#item-cost").value = item.cost;
    document.querySelector("#item-profit").value = item.profit;

    addModalOverlay.classList.remove("hidden");
    document.querySelector("#item-type").focus();
}

function closeAddModal() {
    addModalOverlay.classList.add("hidden");
    itemForm.reset();
    editingControlNumber = null;
    modalTitle.textContent = "Add Product";
    saveItemBtn.textContent = "Save Item";
    qtyFieldWrapper.classList.remove("hidden");
}

openAddModalBtn.addEventListener("click", openAddModal);
closeAddModalBtn.addEventListener("click", closeAddModal);
cancelAddModalBtn.addEventListener("click", closeAddModal);

// Close modal when clicking outside the card
addModalOverlay.addEventListener("click", (e) => {
    if (e.target === addModalOverlay) {
        closeAddModal();
    }
});

// Close modal with Escape key
document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
        if (!addModalOverlay.classList.contains("hidden")) {
            closeAddModal();
        }
        if (!soldModalOverlay.classList.contains("hidden")) {
            closeSoldModal();
        }
    }
});

// ---------- Add / Update Item ----------
itemForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const typeInput = document.querySelector("#item-type");
    const qtyInput = document.querySelector("#item-qty");
    const costInput = document.querySelector("#item-cost");
    const profitInput = document.querySelector("#item-profit");

    const cost = parseFloat(costInput.value) || 0;
    const profit = parseFloat(profitInput.value) || 0;
    const price = cost + profit; // Price is always derived, never entered directly.

    if (editingControlNumber === null) {
        // Adding new item(s): date is captured automatically, not entered by the user.
        const today = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
        const count = Math.max(1, parseInt(qtyInput.value) || 1);

        // Each unit gets its own row/control number, but shares the same details.
        for (let i = 0; i < count; i++) {
            await db.execute(
                "INSERT INTO inventory (product_type, price, cost, profit, date) VALUES ($1, $2, $3, $4, $5)",
                [typeInput.value, price, cost, profit, today]
            );
        }
    } else {
        // Editing an existing single item: keep its original date, just update the details.
        await db.execute(
            "UPDATE inventory SET product_type = $1, price = $2, cost = $3, profit = $4 WHERE control_number = $5",
            [typeInput.value, price, cost, profit, editingControlNumber]
        );
    }

    closeAddModal();
    loadItems();
    refreshSecondaryViewsIfVisible();
});

// Keeps Home and Dashboard in sync whenever inventory or sales data changes,
// but only re-queries them if they're the view currently on screen.
function refreshSecondaryViewsIfVisible() {
    if (!document.getElementById("dashboard-view").classList.contains("hidden")) {
        loadDashboard();
    }
    if (!document.getElementById("home-view").classList.contains("hidden")) {
        loadHome();
    }
}

// ---------- Delete Item ----------
async function deleteItem(controlNumber) {
    const confirmed = window.confirm(`Delete item #${controlNumber}? This cannot be undone.`);
    if (!confirmed) return;

    await db.execute("DELETE FROM inventory WHERE control_number = $1", [controlNumber]);
    loadItems();
    refreshSecondaryViewsIfVisible();
}

// ---------- Mark as Sold ----------
function openSoldModal() {
    pendingSoldItem = null;
    soldControlNumberInput.value = "";
    soldLookupError.textContent = "";
    soldLookupStep.classList.remove("hidden");
    soldConfirmStep.classList.add("hidden");
    soldModalOverlay.classList.remove("hidden");
    soldControlNumberInput.focus();
}

function closeSoldModal() {
    soldModalOverlay.classList.add("hidden");
    pendingSoldItem = null;
    soldControlNumberInput.value = "";
    soldLookupError.textContent = "";
    resetDiscountFields();
}

function resetDiscountFields() {
    soldDiscountType.value = "none";
    soldDiscountValue.value = "";
    soldDiscountValue.classList.add("hidden");
}

// Calculates how much is taken off, and the resulting final price, for the
// currently selected discount type ("percent" or "fixed") and entered value.
function computeDiscount(item, discountType, rawValue) {
    if (!item) {
        return { discountAmount: 0, finalPrice: 0 };
    }

    const price = Number(item.price) || 0;

    if (discountType === "percent") {
        const pct = Math.min(100, Math.max(0, parseFloat(rawValue) || 0));
        const discountAmount = (price * pct) / 100;
        return { discountAmount, finalPrice: Math.max(0, price - discountAmount) };
    }

    if (discountType === "fixed") {
        const discountAmount = Math.min(price, Math.max(0, parseFloat(rawValue) || 0));
        return { discountAmount, finalPrice: Math.max(0, price - discountAmount) };
    }

    // No discount
    return { discountAmount: 0, finalPrice: price };
}

function updateFinalPriceDisplay() {
    if (!pendingSoldItem) return;
    const { finalPrice } = computeDiscount(pendingSoldItem, soldDiscountType.value, soldDiscountValue.value);
    soldDetailFinalPrice.textContent = formatCurrency(finalPrice);
}

soldDiscountType.addEventListener("change", () => {
    if (soldDiscountType.value === "none") {
        soldDiscountValue.classList.add("hidden");
        soldDiscountValue.value = "";
    } else {
        soldDiscountValue.classList.remove("hidden");
        soldDiscountValue.focus();
    }
    updateFinalPriceDisplay();
});

soldDiscountValue.addEventListener("input", updateFinalPriceDisplay);

async function findSoldItem() {
    const controlNumber = parseInt(soldControlNumberInput.value);
    soldLookupError.textContent = "";

    if (!controlNumber) {
        soldLookupError.textContent = "Please enter a control number.";
        return;
    }

    const results = await db.select(
        "SELECT * FROM inventory WHERE control_number = $1",
        [controlNumber]
    );

    if (results.length === 0) {
        soldLookupError.textContent = `No item found with control number ${controlNumber}.`;
        return;
    }

    pendingSoldItem = results[0];
    resetDiscountFields();

    document.querySelector("#sold-detail-control-number").textContent = pendingSoldItem.control_number;
    document.querySelector("#sold-detail-product-type").textContent = pendingSoldItem.product_type;
    document.querySelector("#sold-detail-price").textContent = formatCurrency(pendingSoldItem.price);
    document.querySelector("#sold-detail-cost").textContent = formatCurrency(pendingSoldItem.cost);
    document.querySelector("#sold-detail-profit").textContent = formatCurrency(pendingSoldItem.profit);
    document.querySelector("#sold-detail-date").textContent = formatDate(pendingSoldItem.date);

    updateFinalPriceDisplay();

    soldLookupStep.classList.add("hidden");
    soldConfirmStep.classList.remove("hidden");
}

async function confirmSoldItem() {
    if (!pendingSoldItem) return;

    const dateSold = new Date().toISOString().split("T")[0];
    const discountType = soldDiscountType.value;
    const discountValue = parseFloat(soldDiscountValue.value) || 0;
    const { discountAmount, finalPrice } = computeDiscount(pendingSoldItem, discountType, soldDiscountValue.value);

    // Profit reflects what was actually collected: final price minus cost.
    // Discounting eats into profit first, since cost never changes.
    const finalProfit = finalPrice - (Number(pendingSoldItem.cost) || 0);

    await db.execute(
        `INSERT INTO sold_items
            (control_number, product_type, price, cost, profit, date_added, date_sold,
             original_price, discount_type, discount_value, discount_amount)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
            pendingSoldItem.control_number,
            pendingSoldItem.product_type,
            finalPrice,
            pendingSoldItem.cost,
            finalProfit,
            pendingSoldItem.date,
            dateSold,
            pendingSoldItem.price,
            discountType,
            discountValue,
            discountAmount
        ]
    );

    await db.execute(
        "DELETE FROM inventory WHERE control_number = $1",
        [pendingSoldItem.control_number]
    );

    closeSoldModal();
    loadItems();
    refreshSecondaryViewsIfVisible();
}

openSoldModalBtn.addEventListener("click", openSoldModal);
closeSoldModalBtn.addEventListener("click", closeSoldModal);
cancelSoldModalBtn.addEventListener("click", closeSoldModal);
cancelSoldConfirmBtn.addEventListener("click", closeSoldModal);
findSoldItemBtn.addEventListener("click", findSoldItem);
confirmSoldBtn.addEventListener("click", confirmSoldItem);

soldControlNumberInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
        e.preventDefault();
        findSoldItem();
    }
});

soldModalOverlay.addEventListener("click", (e) => {
    if (e.target === soldModalOverlay) {
        closeSoldModal();
    }
});

// ---------- Fetch + Sort + Filter + Render ----------
async function loadItems() {
    currentItems = await db.select("SELECT * FROM inventory");
    applySortAndRender();
}

// Returns the today/week-start/month-start/year-start boundary strings (YYYY-MM-DD),
// used both by the inventory date filter and the dashboard KPI cards.
function getDateBoundaries() {
    const now = new Date();
    const todayStr = now.toISOString().split("T")[0];

    // Monday-start week. getDay(): 0 = Sunday ... 6 = Saturday.
    const dayOfWeek = now.getDay();
    const diffToMonday = (dayOfWeek === 0 ? -6 : 1) - dayOfWeek;
    const monday = new Date(now);
    monday.setDate(now.getDate() + diffToMonday);
    const weekStartStr = monday.toISOString().split("T")[0];

    const monthStartStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
    const yearStartStr = `${now.getFullYear()}-01-01`;

    return { todayStr, weekStartStr, monthStartStr, yearStartStr };
}

function itemMatchesFilters(item) {
    const productFilter = productTypeSelect.value;
    if (productFilter !== "all" && item.product_type !== productFilter) {
        return false;
    }

    const dateMode = dateRangeSelect.value;
    if (dateMode === "all") {
        return true;
    }

    const { todayStr, weekStartStr, monthStartStr, yearStartStr } = getDateBoundaries();
    const itemDate = item.date;

    if (dateMode === "today") return itemDate === todayStr;
    if (dateMode === "week") return itemDate >= weekStartStr && itemDate <= todayStr;
    if (dateMode === "month") return itemDate >= monthStartStr && itemDate <= todayStr;
    if (dateMode === "year") return itemDate >= yearStartStr && itemDate <= todayStr;

    if (dateMode === "custom") {
        const from = dateFromInput.value;
        const to = dateToInput.value;
        if (from && itemDate < from) return false;
        if (to && itemDate > to) return false;
        return true;
    }

    return true;
}

// Toggle the From/To date inputs only when "Custom Range" is selected.
dateRangeSelect.addEventListener("change", () => {
    if (dateRangeSelect.value === "custom") {
        customDateFieldsWrapper.classList.remove("hidden");
    } else {
        customDateFieldsWrapper.classList.add("hidden");
    }
    applySortAndRender();
});

productTypeSelect.addEventListener("change", applySortAndRender);
dateFromInput.addEventListener("change", applySortAndRender);
dateToInput.addEventListener("change", applySortAndRender);

function applySortAndRender() {
    const filtered = currentItems.filter(itemMatchesFilters);
    const sorted = sortItems(filtered, sortState.column, sortState.direction);
    renderTable(sorted, filtered.length);
    updateSortIcons();
}

function sortItems(items, column, direction) {
    const sorted = [...items].sort((a, b) => {
        let valA = a[column];
        let valB = b[column];

        if (column === "product_type") {
            valA = (valA || "").toLowerCase();
            valB = (valB || "").toLowerCase();
            if (valA < valB) return direction === "asc" ? -1 : 1;
            if (valA > valB) return direction === "asc" ? 1 : -1;
            return 0;
        }

        if (column === "date") {
            valA = new Date(valA).getTime();
            valB = new Date(valB).getTime();
        }

        // Numeric comparison for control_number, price, cost, profit, date
        return direction === "asc" ? valA - valB : valB - valA;
    });

    return sorted;
}

function updateSortIcons() {
    sortableHeaders.forEach(th => {
        const icon = th.querySelector(".sort-icon");
        if (th.dataset.sort === sortState.column) {
            icon.textContent = sortState.direction === "desc" ? "▼" : "▲";
        } else {
            icon.textContent = "";
        }
    });
}

sortableHeaders.forEach(th => {
    th.addEventListener("click", () => {
        const column = th.dataset.sort;

        if (sortState.column === column) {
            // Same column clicked again: flip direction.
            sortState.direction = sortState.direction === "desc" ? "asc" : "desc";
        } else {
            // New column: default to highest-to-lowest first.
            sortState.column = column;
            sortState.direction = "desc";
        }

        applySortAndRender();
    });
});

function renderTable(items, filteredCount) {
    inventoryTableBody.innerHTML = "";

    const hasActiveFilter = productTypeSelect.value !== "all" || dateRangeSelect.value !== "all";

    if (items.length === 0) {
        emptyState.classList.remove("hidden");
        emptyState.textContent = hasActiveFilter
            ? "No items match the selected filters."
            : 'No items yet. Click "Add Product" to get started.';
        return;
    }
    emptyState.classList.add("hidden");

    items.forEach(item => {
        const row = document.createElement("tr");

        const idCell = document.createElement("td");
        idCell.textContent = item.control_number;

        const typeCell = document.createElement("td");
        typeCell.textContent = item.product_type;

        const priceCell = document.createElement("td");
        priceCell.textContent = formatCurrency(item.price);

        const costCell = document.createElement("td");
        costCell.textContent = formatCurrency(item.cost);

        const profitCell = document.createElement("td");
        profitCell.textContent = formatCurrency(item.profit);

        const dateCell = document.createElement("td");
        dateCell.textContent = formatDate(item.date);

        const actionsCell = document.createElement("td");
        actionsCell.className = "actions-cell";

        const editBtn = document.createElement("button");
        editBtn.type = "button";
        editBtn.className = "btn-icon btn-edit";
        editBtn.textContent = "Edit";
        editBtn.addEventListener("click", () => openEditModal(item));

        const deleteBtn = document.createElement("button");
        deleteBtn.type = "button";
        deleteBtn.className = "btn-icon btn-delete";
        deleteBtn.textContent = "Delete";
        deleteBtn.addEventListener("click", () => deleteItem(item.control_number));

        actionsCell.appendChild(editBtn);
        actionsCell.appendChild(deleteBtn);

        row.appendChild(idCell);
        row.appendChild(typeCell);
        row.appendChild(priceCell);
        row.appendChild(costCell);
        row.appendChild(profitCell);
        row.appendChild(dateCell);
        row.appendChild(actionsCell);

        inventoryTableBody.appendChild(row);
    });
}

function formatCurrency(value) {
    const num = Number(value);
    if (Number.isNaN(num)) return value;
    return num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatDate(isoDate) {
    if (!isoDate) return "";
    const d = new Date(isoDate);
    if (Number.isNaN(d.getTime())) return isoDate;
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

// Renders a sold item's discount as something like "10% (-250.00)" or
// "Fixed (-500.00)", or "—" if no discount was applied.
function formatDiscount(item) {
    const discountType = item.discount_type;
    const discountAmount = Number(item.discount_amount) || 0;

    if (!discountType || discountType === "none" || discountAmount === 0) {
        return "—";
    }

    if (discountType === "percent") {
        const pct = Number(item.discount_value) || 0;
        return `${pct}% (-${formatCurrency(discountAmount)})`;
    }

    if (discountType === "fixed") {
        return `Fixed (-${formatCurrency(discountAmount)})`;
    }

    return "—";
}

// ---------- Dashboard ----------
async function loadDashboard() {
    const soldItems = await db.select("SELECT * FROM sold_items ORDER BY date_sold DESC, id DESC");

    renderKpiCards(soldItems);
    renderBestSeller(soldItems);
    renderSalesTrendChart(soldItems);
    renderSoldTable(soldItems);
}

function summarizePeriod(soldItems, startDateStr, endDateStr) {
    const inRange = soldItems.filter(item => {
        return item.date_sold >= startDateStr && item.date_sold <= endDateStr;
    });

    const revenue = inRange.reduce((sum, item) => sum + (Number(item.price) || 0), 0);
    const cost = inRange.reduce((sum, item) => sum + (Number(item.cost) || 0), 0);
    const profit = inRange.reduce((sum, item) => sum + (Number(item.profit) || 0), 0);

    return { count: inRange.length, revenue, cost, profit };
}

function renderKpiCards(soldItems) {
    const { todayStr, weekStartStr, monthStartStr } = getDateBoundaries();

    const today = summarizePeriod(soldItems, todayStr, todayStr);
    const week = summarizePeriod(soldItems, weekStartStr, todayStr);
    const month = summarizePeriod(soldItems, monthStartStr, todayStr);

    document.querySelector("#kpi-today-count").textContent = `${today.count} item${today.count === 1 ? "" : "s"} sold`;
    document.querySelector("#kpi-today-revenue").textContent = formatCurrency(today.revenue);
    document.querySelector("#kpi-today-cost").textContent = formatCurrency(today.cost);
    document.querySelector("#kpi-today-profit").textContent = formatCurrency(today.profit);

    document.querySelector("#kpi-week-count").textContent = `${week.count} item${week.count === 1 ? "" : "s"} sold`;
    document.querySelector("#kpi-week-revenue").textContent = formatCurrency(week.revenue);
    document.querySelector("#kpi-week-cost").textContent = formatCurrency(week.cost);
    document.querySelector("#kpi-week-profit").textContent = formatCurrency(week.profit);

    document.querySelector("#kpi-month-count").textContent = `${month.count} item${month.count === 1 ? "" : "s"} sold`;
    document.querySelector("#kpi-month-revenue").textContent = formatCurrency(month.revenue);
    document.querySelector("#kpi-month-cost").textContent = formatCurrency(month.cost);
    document.querySelector("#kpi-month-profit").textContent = formatCurrency(month.profit);
}

// Returns the top-selling product type and its all-time sold count.
function computeBestSeller(soldItems) {
    if (soldItems.length === 0) {
        return { type: null, count: 0 };
    }

    const counts = {};
    soldItems.forEach(item => {
        counts[item.product_type] = (counts[item.product_type] || 0) + 1;
    });

    let topType = null;
    let topCount = 0;
    Object.entries(counts).forEach(([type, count]) => {
        if (count > topCount) {
            topType = type;
            topCount = count;
        }
    });

    return { type: topType, count: topCount };
}

function renderBestSeller(soldItems) {
    const nameEl = document.querySelector("#kpi-best-seller-name");
    const subEl = document.querySelector("#kpi-best-seller-sub");
    const { type, count } = computeBestSeller(soldItems);

    if (!type) {
        nameEl.textContent = "—";
        subEl.textContent = "No sales recorded yet";
        return;
    }

    nameEl.textContent = type;
    subEl.textContent = `${count} sold all-time`;
}

function renderSalesTrendChart(soldItems) {
    // Build the last 7 calendar days (oldest to newest, today last).
    const days = [];
    for (let i = 6; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        days.push(d.toISOString().split("T")[0]);
    }

    const revenueByDay = days.map(dateStr => {
        return soldItems
            .filter(item => item.date_sold === dateStr)
            .reduce((sum, item) => sum + (Number(item.price) || 0), 0);
    });

    const labels = days.map(dateStr => {
        const d = new Date(dateStr);
        return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    });

    if (salesTrendChart) {
        salesTrendChart.destroy();
    }

    salesTrendChart = new Chart(salesTrendCanvas, {
        type: "bar",
        data: {
            labels,
            datasets: [{
                label: "Revenue",
                data: revenueByDay,
                backgroundColor: "#c9a24a",
                borderRadius: 4,
                maxBarThickness: 42
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    ticks: {
                        callback: (value) => formatCurrency(value)
                    }
                }
            }
        }
    });
}

function renderSoldTable(soldItems) {
    soldTableBody.innerHTML = "";

    if (soldItems.length === 0) {
        soldEmptyState.classList.remove("hidden");
        return;
    }
    soldEmptyState.classList.add("hidden");

    soldItems.forEach(item => {
        const row = document.createElement("tr");

        const idCell = document.createElement("td");
        idCell.textContent = item.control_number;

        const typeCell = document.createElement("td");
        typeCell.textContent = item.product_type;

        const originalPriceCell = document.createElement("td");
        originalPriceCell.textContent = formatCurrency(item.original_price || item.price);

        const discountCell = document.createElement("td");
        discountCell.textContent = formatDiscount(item);

        const finalPriceCell = document.createElement("td");
        finalPriceCell.textContent = formatCurrency(item.price);

        const costCell = document.createElement("td");
        costCell.textContent = formatCurrency(item.cost);

        const profitCell = document.createElement("td");
        profitCell.textContent = formatCurrency(item.profit);

        const dateAddedCell = document.createElement("td");
        dateAddedCell.textContent = formatDate(item.date_added);

        const dateSoldCell = document.createElement("td");
        dateSoldCell.textContent = formatDate(item.date_sold);

        row.appendChild(idCell);
        row.appendChild(typeCell);
        row.appendChild(originalPriceCell);
        row.appendChild(discountCell);
        row.appendChild(finalPriceCell);
        row.appendChild(costCell);
        row.appendChild(profitCell);
        row.appendChild(dateAddedCell);
        row.appendChild(dateSoldCell);

        soldTableBody.appendChild(row);
    });
}

// ---------- Home ----------
async function loadHome() {
    const inventoryItems = await db.select("SELECT * FROM inventory");
    const soldItems = await db.select("SELECT * FROM sold_items ORDER BY date_sold DESC, id DESC");

    renderHomeDate();
    renderHomeStats(inventoryItems, soldItems);
    renderHomePopularityChart(soldItems);
    renderHomeProfitTrendChart(soldItems);
    renderHomeActivity(inventoryItems, soldItems);
}

function renderHomeDate() {
    homeDateSubtitle.textContent = new Date().toLocaleDateString(undefined, {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric"
    });
}

function renderHomeStats(inventoryItems, soldItems) {
    homeStatStock.textContent = inventoryItems.length;

    const { todayStr, weekStartStr, monthStartStr } = getDateBoundaries();

    // Sold / profit this month
    const soldThisMonth = soldItems.filter(i => i.date_sold >= monthStartStr && i.date_sold <= todayStr);
    homeStatSoldMonth.textContent = soldThisMonth.length;
    homeStatSoldMonthSub.textContent = `${soldThisMonth.length} item${soldThisMonth.length === 1 ? "" : "s"} sold`;

    const profitThisMonth = soldThisMonth.reduce((sum, i) => sum + (Number(i.profit) || 0), 0);
    homeStatProfitMonth.textContent = formatCurrency(profitThisMonth);

    // This week vs last week profit, to show whether the business is trending up or down.
    const thisWeekStart = new Date(weekStartStr);
    const prevWeekStart = new Date(thisWeekStart);
    prevWeekStart.setDate(prevWeekStart.getDate() - 7);
    const prevWeekEnd = new Date(thisWeekStart);
    prevWeekEnd.setDate(prevWeekEnd.getDate() - 1);
    const prevWeekStartStr = prevWeekStart.toISOString().split("T")[0];
    const prevWeekEndStr = prevWeekEnd.toISOString().split("T")[0];

    const thisWeekProfit = soldItems
        .filter(i => i.date_sold >= weekStartStr && i.date_sold <= todayStr)
        .reduce((sum, i) => sum + (Number(i.profit) || 0), 0);
    const prevWeekProfit = soldItems
        .filter(i => i.date_sold >= prevWeekStartStr && i.date_sold <= prevWeekEndStr)
        .reduce((sum, i) => sum + (Number(i.profit) || 0), 0);

    const trendEl = homeStatProfitTrend;
    trendEl.classList.remove("trend-up", "trend-down", "trend-neutral");

    if (prevWeekProfit === 0 && thisWeekProfit === 0) {
        trendEl.textContent = "No sales yet this week or last week";
        trendEl.classList.add("trend-neutral");
    } else if (prevWeekProfit === 0) {
        trendEl.textContent = `▲ New profit this week (${formatCurrency(thisWeekProfit)})`;
        trendEl.classList.add("trend-up");
    } else {
        const pctChange = ((thisWeekProfit - prevWeekProfit) / Math.abs(prevWeekProfit)) * 100;
        const rounded = Math.abs(pctChange).toFixed(1);
        if (pctChange >= 0) {
            trendEl.textContent = `▲ ${rounded}% vs last week`;
            trendEl.classList.add("trend-up");
        } else {
            trendEl.textContent = `▼ ${rounded}% vs last week`;
            trendEl.classList.add("trend-down");
        }
    }

    // Most popular item (all-time)
    const { type, count } = computeBestSeller(soldItems);
    if (type) {
        homePopularItem.textContent = type;
        homePopularItemSub.textContent = `${count} sold all-time`;
    } else {
        homePopularItem.textContent = "—";
        homePopularItemSub.textContent = "No sales recorded yet";
    }
}

function renderHomePopularityChart(soldItems) {
    const counts = {};
    soldItems.forEach(item => {
        counts[item.product_type] = (counts[item.product_type] || 0) + 1;
    });

    const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    const top = entries.slice(0, 5);
    const rest = entries.slice(5);
    const restTotal = rest.reduce((sum, [, c]) => sum + c, 0);

    let labels = top.map(([type]) => type);
    let data = top.map(([, c]) => c);

    if (restTotal > 0) {
        labels.push("Other");
        data.push(restTotal);
    }

    if (labels.length === 0) {
        labels = ["No sales yet"];
        data = [1];
    }

    if (homePopularityChart) {
        homePopularityChart.destroy();
    }

    homePopularityChart = new Chart(homePopularityCanvas, {
        type: "doughnut",
        data: {
            labels,
            datasets: [{
                data,
                backgroundColor: CHART_PALETTE,
                borderWidth: 0
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    position: "bottom",
                    labels: { boxWidth: 12, font: { size: 11 } }
                }
            }
        }
    });
}

function renderHomeProfitTrendChart(soldItems) {
    // Last 14 calendar days (oldest to newest, today last).
    const days = [];
    for (let i = 13; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        days.push(d.toISOString().split("T")[0]);
    }

    const profitByDay = days.map(dateStr => {
        return soldItems
            .filter(item => item.date_sold === dateStr)
            .reduce((sum, item) => sum + (Number(item.profit) || 0), 0);
    });

    const labels = days.map(dateStr => {
        const d = new Date(dateStr);
        return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    });

    if (homeProfitTrendChart) {
        homeProfitTrendChart.destroy();
    }

    homeProfitTrendChart = new Chart(homeProfitTrendCanvas, {
        type: "line",
        data: {
            labels,
            datasets: [{
                label: "Profit",
                data: profitByDay,
                borderColor: "#c9a24a",
                backgroundColor: "rgba(201, 162, 74, 0.15)",
                fill: true,
                tension: 0.3,
                pointRadius: 3,
                pointBackgroundColor: "#c9a24a"
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    ticks: {
                        callback: (value) => formatCurrency(value)
                    }
                }
            }
        }
    });
}

function renderHomeActivity(inventoryItems, soldItems) {
    const addedEntries = inventoryItems.map(item => ({ kind: "added", date: item.date, item }));
    const soldEntries = soldItems.map(item => ({ kind: "sold", date: item.date_sold, item }));

    const combined = [...addedEntries, ...soldEntries]
        .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
        .slice(0, 8);

    homeActivityList.innerHTML = "";

    if (combined.length === 0) {
        homeActivityEmpty.classList.remove("hidden");
        return;
    }
    homeActivityEmpty.classList.add("hidden");

    combined.forEach(entry => {
        const li = document.createElement("li");
        li.className = "activity-item";

        const icon = document.createElement("span");
        icon.className = "activity-icon " + (entry.kind === "sold" ? "activity-icon-sold" : "activity-icon-added");
        icon.textContent = entry.kind === "sold" ? "$" : "+";

        const text = document.createElement("span");
        text.className = "activity-text";
        text.textContent = entry.kind === "sold"
            ? `Sold ${entry.item.product_type} (#${entry.item.control_number}) for ${formatCurrency(entry.item.price)}`
            : `Added ${entry.item.product_type} (#${entry.item.control_number})`;

        const dateSpan = document.createElement("span");
        dateSpan.className = "activity-date";
        dateSpan.textContent = formatDate(entry.date);

        li.appendChild(icon);
        li.appendChild(text);
        li.appendChild(dateSpan);

        homeActivityList.appendChild(li);
    });
}