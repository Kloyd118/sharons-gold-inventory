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
        { name: "date_sold", type: "TEXT" }
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
const summaryPanel = document.querySelector("#product-summary");

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

// Dashboard elements
const soldTableBody = document.querySelector("#sold-list");
const soldEmptyState = document.querySelector("#sold-empty-state");
const salesTrendCanvas = document.querySelector("#sales-trend-chart");
let salesTrendChart = null; // Chart.js instance, recreated each time the dashboard loads

// Holds the item currently pending sale confirmation.
let pendingSoldItem = null;

// Tracks which control_number is currently being edited.
// null means the modal is in "add new item" mode.
let editingControlNumber = null;

// Keeps the last-loaded items in memory so sorting/filtering doesn't need to re-query the DB.
let currentItems = [];
// Default: sort by control_number, highest first.
let sortState = { column: "control_number", direction: "desc" };
// When set to a product type string, the table only shows rows of that type.
let activeFilter = null;

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
    });
});

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
});

// ---------- Delete Item ----------
async function deleteItem(controlNumber) {
    const confirmed = window.confirm(`Delete item #${controlNumber}? This cannot be undone.`);
    if (!confirmed) return;

    await db.execute("DELETE FROM inventory WHERE control_number = $1", [controlNumber]);
    loadItems();
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
}

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

    document.querySelector("#sold-detail-control-number").textContent = pendingSoldItem.control_number;
    document.querySelector("#sold-detail-product-type").textContent = pendingSoldItem.product_type;
    document.querySelector("#sold-detail-price").textContent = formatCurrency(pendingSoldItem.price);
    document.querySelector("#sold-detail-cost").textContent = formatCurrency(pendingSoldItem.cost);
    document.querySelector("#sold-detail-profit").textContent = formatCurrency(pendingSoldItem.profit);
    document.querySelector("#sold-detail-date").textContent = formatDate(pendingSoldItem.date);

    soldLookupStep.classList.add("hidden");
    soldConfirmStep.classList.remove("hidden");
}

async function confirmSoldItem() {
    if (!pendingSoldItem) return;

    const dateSold = new Date().toISOString().split("T")[0];

    await db.execute(
        "INSERT INTO sold_items (control_number, product_type, price, cost, profit, date_added, date_sold) VALUES ($1, $2, $3, $4, $5, $6, $7)",
        [
            pendingSoldItem.control_number,
            pendingSoldItem.product_type,
            pendingSoldItem.price,
            pendingSoldItem.cost,
            pendingSoldItem.profit,
            pendingSoldItem.date,
            dateSold
        ]
    );

    await db.execute(
        "DELETE FROM inventory WHERE control_number = $1",
        [pendingSoldItem.control_number]
    );

    closeSoldModal();
    loadItems();

    // Keep the dashboard in sync if it's currently the active view.
    if (!document.getElementById("dashboard-view").classList.contains("hidden")) {
        loadDashboard();
    }
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
    renderSummary();
    applySortAndRender();
}

function renderSummary() {
    // Count how many rows exist per product type.
    const counts = {};
    currentItems.forEach(item => {
        counts[item.product_type] = (counts[item.product_type] || 0) + 1;
    });

    const types = Object.keys(counts).sort();

    summaryPanel.innerHTML = "";

    // "All" chip resets the filter and shows the full inventory.
    const allChip = document.createElement("button");
    allChip.type = "button";
    allChip.className = "summary-chip" + (activeFilter === null ? " active" : "");
    allChip.textContent = `All (${currentItems.length})`;
    allChip.addEventListener("click", () => {
        activeFilter = null;
        applySortAndRender();
        renderSummary();
    });
    summaryPanel.appendChild(allChip);

    if (types.length === 0) {
        const emptyNote = document.createElement("span");
        emptyNote.className = "summary-empty-note";
        emptyNote.textContent = "Add products to see totals by type.";
        summaryPanel.appendChild(emptyNote);
        return;
    }

    types.forEach(type => {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "summary-chip" + (activeFilter === type ? " active" : "");
        chip.textContent = `${type} (${counts[type]})`;
        chip.addEventListener("click", () => {
            // Clicking the already-active chip clears the filter.
            activeFilter = activeFilter === type ? null : type;
            applySortAndRender();
            renderSummary();
        });
        summaryPanel.appendChild(chip);
    });
}

function applySortAndRender() {
    const filtered = activeFilter
        ? currentItems.filter(item => item.product_type === activeFilter)
        : currentItems;
    const sorted = sortItems(filtered, sortState.column, sortState.direction);
    renderTable(sorted);
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

function renderTable(items) {
    inventoryTableBody.innerHTML = "";

    if (items.length === 0) {
        emptyState.classList.remove("hidden");
        emptyState.textContent = activeFilter
            ? `No items found for "${activeFilter}".`
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

// ---------- Dashboard ----------
async function loadDashboard() {
    const soldItems = await db.select("SELECT * FROM sold_items ORDER BY date_sold DESC, id DESC");

    renderKpiCards(soldItems);
    renderBestSeller(soldItems);
    renderSalesTrendChart(soldItems);
    renderSoldTable(soldItems);
}

// Returns YYYY-MM-DD for "today" and the Monday that starts the current week.
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

    return { todayStr, weekStartStr, monthStartStr };
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

function renderBestSeller(soldItems) {
    const nameEl = document.querySelector("#kpi-best-seller-name");
    const subEl = document.querySelector("#kpi-best-seller-sub");

    if (soldItems.length === 0) {
        nameEl.textContent = "—";
        subEl.textContent = "No sales recorded yet";
        return;
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

    nameEl.textContent = topType;
    subEl.textContent = `${topCount} sold all-time`;
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

        const priceCell = document.createElement("td");
        priceCell.textContent = formatCurrency(item.price);

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
        row.appendChild(priceCell);
        row.appendChild(costCell);
        row.appendChild(profitCell);
        row.appendChild(dateAddedCell);
        row.appendChild(dateSoldCell);

        soldTableBody.appendChild(row);
    });
}