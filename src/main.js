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
        { name: "date", type: "TEXT" },
        { name: "branch", type: "TEXT" },
        { name: "weight_grams", type: "REAL" },
        { name: "price_per_gram", type: "REAL" }
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
        { name: "discount_amount", type: "REAL DEFAULT 0" },
        { name: "branch", type: "TEXT" }
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


async function ensureUsersTable() {
    await db.execute(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT,
            role TEXT,
            location TEXT,
            password TEXT
        )
    `);

    // If the table already existed from an earlier version, patch in the
    // location column without touching any existing rows.
    await addMissingColumns("users", [
        { name: "name", type: "TEXT" },
        { name: "role", type: "TEXT" },
        { name: "location", type: "TEXT" },
        { name: "password", type: "TEXT" }
    ]);

    // Enforces "only 1 admin" at the database level: a unique index that only
    // applies to rows where role = 'admin'. A second admin insert will fail outright.
    await db.execute(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_single_admin
        ON users(role)
        WHERE role = 'admin'
    `);

    // Seed the one admin account, but only if an admin doesn't already exist.
    const existingAdmin = await db.select("SELECT id FROM users WHERE role = 'admin'");
    if (existingAdmin.length === 0) {
        await db.execute(
            "INSERT INTO users (name, role, location, password) VALUES ($1, $2, $3, $4)",
            ["user", "admin", "admin", "pass123"]
        );
        console.info('Seeded the initial admin account (name: "user", location: "admin").');
    } else {
        // Admin already existed from before location was added — backfill it
        // so the seeded account matches what you asked for.
        await db.execute(
            "UPDATE users SET location = 'admin' WHERE role = 'admin' AND (location IS NULL OR location = '')"
        );
    }
}

async function ensureExpensesTable() {
    await db.execute(`
        CREATE TABLE IF NOT EXISTS expenses (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            type TEXT,
            branch TEXT,
            transaction_text TEXT,
            amount REAL,
            date TEXT
        )
    `);

    await addMissingColumns("expenses", [
        { name: "type", type: "TEXT" },
        { name: "branch", type: "TEXT" },
        { name: "transaction_text", type: "TEXT" },
        { name: "amount", type: "REAL" },
        { name: "date", type: "TEXT" }
    ]);
}
await ensureInventoryTable();

await ensureUsersTable();

await ensureExpensesTable();


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
const productTypeSelect = document.querySelector("#filter-product-type");
const dateRangeSelect = document.querySelector("#filter-date-range");
const customDateFieldsWrapper = document.querySelector("#custom-date-fields");
const dateFromInput = document.querySelector("#filter-date-from");
const dateToInput = document.querySelector("#filter-date-to");
const inventorySearchInput = document.querySelector("#filter-search");
const inventoryBranchSelect = document.querySelector("#filter-branch");

const addUserModalOverlay = document.querySelector("#add-user-modal-overlay");
const openAddUserModalBtn = document.querySelector("#open-add-user-modal");
const closeAddUserModalBtn = document.querySelector("#close-add-user-modal");
const cancelAddUserBtn = document.querySelector("#cancel-add-user");
const addUserForm = document.querySelector("#add-user-form");
const addUserError = document.querySelector("#add-user-error");

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

// Reports elements
const openExpenseModalBtn = document.querySelector("#open-expense-modal");
const closeExpenseModalBtn = document.querySelector("#close-expense-modal");
const cancelExpenseModalBtn = document.querySelector("#cancel-expense-modal");
const expenseModalOverlay = document.querySelector("#expense-modal-overlay");
const expenseForm = document.querySelector("#expense-form");

const openDepositModalBtn = document.querySelector("#open-deposit-modal");
const closeDepositModalBtn = document.querySelector("#close-deposit-modal");
const cancelDepositModalBtn = document.querySelector("#cancel-deposit-modal");
const depositModalOverlay = document.querySelector("#deposit-modal-overlay");
const depositForm = document.querySelector("#deposit-form");

const reportsBranchSelect = document.querySelector("#filter-reports-branch");
const reportsDateRangeSelect = document.querySelector("#filter-reports-date-range");
const reportsCustomDateFieldsWrapper = document.querySelector("#reports-custom-date-fields");
const reportsDateFromInput = document.querySelector("#filter-reports-date-from");
const reportsDateToInput = document.querySelector("#filter-reports-date-to");
const reportsActivityList = document.querySelector("#reports-activity-list");
const reportsActivityEmpty = document.querySelector("#reports-activity-empty");
let currentExpenses = [];

// Dashboard elements
const salesTrendCanvas = document.querySelector("#sales-trend-chart");
let salesTrendChart = null; // Chart.js instance, recreated each time the dashboard loads

// Transactions elements
const transactionsTableBody = document.querySelector("#transactions-list");
const transactionsEmptyState = document.querySelector("#transactions-empty-state");
const transactionsSearchInput = document.querySelector("#filter-transactions-search");
const transactionsProductTypeSelect = document.querySelector("#filter-transactions-product-type");
const transactionsBranchSelect = document.querySelector("#filter-transactions-branch");
const transactionsDateRangeSelect = document.querySelector("#filter-transactions-date-range");
const transactionsCustomDateFieldsWrapper = document.querySelector("#transactions-custom-date-fields");
const transactionsDateFromInput = document.querySelector("#filter-transactions-date-from");
const transactionsDateToInput = document.querySelector("#filter-transactions-date-to");
const transactionsSortableHeaders = document.querySelectorAll("#transactions-table th[data-sort]");
let transactionsSortState = { column: "date_sold", direction: "desc" };
let currentSoldItems = []; // Holds the last-loaded sold items for live search filtering

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

const branchNavToggle = document.querySelector("#branch-nav-toggle");
const branchSubmenu = document.querySelector("#branch-submenu");
const branchViewTitle = document.querySelector("#branch-view-title");
const branchCashOnHand = document.querySelector("#branch-cash-on-hand");
const branchStockCount = document.querySelector("#branch-stock-count");
const branchUserList = document.querySelector("#branch-user-list");
const branchInventoryList = document.querySelector("#branch-inventory-list");
const branchInventoryEmpty = document.querySelector("#branch-inventory-empty");
const branchSoldList = document.querySelector("#branch-sold-list");
const branchSoldEmpty = document.querySelector("#branch-sold-empty");
const branchExpensesList = document.querySelector("#branch-expenses-list");
const branchExpensesEmpty = document.querySelector("#branch-expenses-empty");

const branchOpenSoldModalBtn = document.querySelector("#branch-open-sold-modal");
const branchOpenExpenseModalBtn = document.querySelector("#branch-open-expense-modal");
const branchOpenDepositModalBtn = document.querySelector("#branch-open-deposit-modal");
const expenseBranchWrapper = document.querySelector("#expense-branch-wrapper");
const depositBranchWrapper = document.querySelector("#deposit-branch-wrapper");

let selectedBranch = null;



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

function openAddUserModal() {
    addUserForm.reset();
    addUserError.textContent = "";
    addUserModalOverlay.classList.remove("hidden");
    document.querySelector("#user-name").focus();
}

function closeAddUserModal() {
    addUserModalOverlay.classList.add("hidden");
    addUserForm.reset();
    addUserError.textContent = "";
}

openAddUserModalBtn.addEventListener("click", openAddUserModal);
closeAddUserModalBtn.addEventListener("click", closeAddUserModal);
cancelAddUserBtn.addEventListener("click", closeAddUserModal);

addUserModalOverlay.addEventListener("click", (e) => {
    if (e.target === addUserModalOverlay) {
        closeAddUserModal();
    }
});

addUserForm.addEventListener("submit", async (e) => {
    e.preventDefault();

    const name = document.querySelector("#user-name").value.trim();
    const role = document.querySelector('input[name="user-role"]:checked').value;
    const location = document.querySelector("#user-location").value;
    const password = document.querySelector("#user-password").value;

    if (!name || !location || !password) {
        addUserError.textContent = "Please fill in all fields.";
        return;
    }

    await db.execute(
        "INSERT INTO users (name, role, location, password) VALUES ($1, $2, $3, $4)",
        [name, role, location, password]
    );

    closeAddUserModal();
});

// ---------- Login ----------
loginForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const user = document.querySelector("#username").value;
    const pass = document.querySelector("#password").value;

    const results = await db.select(
        "SELECT * FROM users WHERE name = $1 AND password = $2",
        [user, pass]
    );

    if (results.length > 0) {
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


branchNavToggle.addEventListener("click", () => {
    branchSubmenu.classList.toggle("hidden");
});

document.querySelectorAll(".branch-submenu-btn").forEach(btn => {
    btn.addEventListener("click", () => {
        selectedBranch = btn.dataset.branch;

        document.querySelectorAll(".branch-submenu-btn").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");

        navBtns.forEach(b => b.classList.remove("active"));
        views.forEach(v => v.classList.add("hidden"));
        document.getElementById("branch-view").classList.remove("hidden");

        loadBranchView();
    });
});







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
        if (target.dataset.target === "transactions-view") {
            loadTransactions();
        }
        if (target.dataset.target === "reports-view") {
            loadReports();
        }

    });
});

// Quick actions on the Home screen reuse the same modals/wizard as the Inventory view.
homeOpenAddModalBtn.addEventListener("click", openAddWizard);
homeOpenSoldModalBtn.addEventListener("click", openSoldModal);

// ---------- Edit Product Modal ----------
// (Adding new products now goes through the step-by-step wizard below.)
function openEditModal(item) {
    editingControlNumber = item.control_number;
    modalTitle.textContent = "Edit Product";
    saveItemBtn.textContent = "Update Item";

    document.querySelector("#item-type").value = item.product_type;
    document.querySelector("#item-branch").value = item.branch || "";
    document.querySelector("#item-cost").value = item.cost;
    document.querySelector("#item-profit").value = item.profit;

    addModalOverlay.classList.remove("hidden");
    document.querySelector("#item-type").focus();
}

function closeAddModal() {
    addModalOverlay.classList.add("hidden");
    itemForm.reset();
    editingControlNumber = null;
}

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
        if (!addWizardOverlay.classList.contains("hidden")) {
            closeAddWizard();
        }
        if (!addUserModalOverlay.classList.contains("hidden")) {
            closeAddUserModal();
        }
        if (!expenseModalOverlay.classList.contains("hidden")) {
            closeExpenseModal();
        }
        if (!depositModalOverlay.classList.contains("hidden")) {
            closeDepositModal();
        }
    }
});

// ---------- Add / Update Item ----------
itemForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const typeInput = document.querySelector("#item-type");
    const branchInput = document.querySelector("#item-branch");
    const costInput = document.querySelector("#item-cost");
    const profitInput = document.querySelector("#item-profit");

    const cost = parseFloat(costInput.value) || 0;
    const profit = parseFloat(profitInput.value) || 0;
    const price = cost + profit; // Price is always derived, never entered directly.

    // This modal now only handles editing an existing single item.
    // Adding new items goes through the step-by-step wizard instead.
    await db.execute(
        "UPDATE inventory SET product_type = $1, branch = $2, price = $3, cost = $4, profit = $5 WHERE control_number = $6",
        [typeInput.value, branchInput.value, price, cost, profit, editingControlNumber]
    );

    closeAddModal();
    loadItems();
    refreshSecondaryViewsIfVisible();
});

// Keeps Home, Dashboard, and Transactions in sync whenever inventory or sales
// data changes, but only re-queries them if they're the view currently on screen.
function refreshSecondaryViewsIfVisible() {
    if (!document.getElementById("dashboard-view").classList.contains("hidden")) {
        loadDashboard();
    }
    if (!document.getElementById("home-view").classList.contains("hidden")) {
        loadHome();
    }
    if (!document.getElementById("transactions-view").classList.contains("hidden")) {
        loadTransactions();
    }
    if (!document.getElementById("reports-view").classList.contains("hidden")) {
        loadReports();
    }
    if (!document.getElementById("branch-view").classList.contains("hidden")) {
        loadBranchView();
    }
}

// ---------- Add Product Wizard ----------
const addWizardOverlay = document.querySelector("#add-wizard-overlay");
const wizardCloseBtn = document.querySelector("#close-add-wizard");
const wizardSteps = {
    branch: document.querySelector("#wizard-step-branch"),
    type: document.querySelector("#wizard-step-type"),
    unit: document.querySelector("#wizard-step-unit"),
    piece: document.querySelector("#wizard-step-piece"),
    gram: document.querySelector("#wizard-step-gram")
};
const gramPricePerGramInput = document.querySelector("#gram-price-per-gram");
const gramEntriesList = document.querySelector("#gram-entries-list");

let wizardBranch = null;
let wizardProductType = null;

function showWizardStep(stepEl) {
    Object.values(wizardSteps).forEach(s => s.classList.add("hidden"));
    stepEl.classList.remove("hidden");
}

function openAddWizard() {
    wizardBranch = null;
    wizardProductType = null;
    gramEntriesList.innerHTML = "";
    gramPricePerGramInput.value = "";
    document.querySelector("#wizard-item-qty").value = 1;
    document.querySelector("#wizard-item-cost").value = "";
    document.querySelector("#wizard-item-profit").value = "";
    showWizardStep(wizardSteps.branch);
    addWizardOverlay.classList.remove("hidden");
}

function closeAddWizard() {
    addWizardOverlay.classList.add("hidden");
}

openAddModalBtn.addEventListener("click", openAddWizard);
wizardCloseBtn.addEventListener("click", closeAddWizard);

addWizardOverlay.addEventListener("click", (e) => {
    if (e.target === addWizardOverlay) {
        closeAddWizard();
    }
});

// Step navigation: "Back" buttons return to whichever step is named in data-back-to.
document.querySelectorAll(".wizard-back-btn").forEach(btn => {
    btn.addEventListener("click", () => {
        showWizardStep(document.getElementById(btn.dataset.backTo));
    });
});

// Step 1: pick a branch
wizardSteps.branch.querySelectorAll(".wizard-option-btn").forEach(btn => {
    btn.addEventListener("click", () => {
        wizardBranch = btn.dataset.branch;
        showWizardStep(wizardSteps.type);
    });
});

// Step 2: pick a product type
wizardSteps.type.querySelectorAll(".wizard-option-btn").forEach(btn => {
    btn.addEventListener("click", () => {
        wizardProductType = btn.dataset.type;
        showWizardStep(wizardSteps.unit);
    });
});

// Step 3: pick per-piece or per-gram, then show the matching final step
// with the branch/type selections summarized as plain text (not editable selects).
wizardSteps.unit.querySelectorAll(".wizard-option-btn").forEach(btn => {
    btn.addEventListener("click", () => {
        const unit = btn.dataset.unit;

        if (unit === "piece") {
            document.querySelector("#summary-branch-piece").textContent = wizardBranch;
            document.querySelector("#summary-type-piece").textContent = wizardProductType;
            showWizardStep(wizardSteps.piece);
        } else {
            document.querySelector("#summary-branch-gram").textContent = wizardBranch;
            document.querySelector("#summary-type-gram").textContent = wizardProductType;
            showWizardStep(wizardSteps.gram);
        }
    });
});

// Step 4a: Per Piece — same math as before (Cost + Profit = Price), just reached
// through the wizard instead of a dropdown-based form.
document.querySelector("#save-piece-btn").addEventListener("click", async () => {
    const qty = Math.max(1, parseInt(document.querySelector("#wizard-item-qty").value) || 1);
    const cost = parseFloat(document.querySelector("#wizard-item-cost").value) || 0;
    const profit = parseFloat(document.querySelector("#wizard-item-profit").value) || 0;
    const price = cost + profit;
    const today = new Date().toISOString().split("T")[0];

    // Each unit gets its own control number, but shares the same details.
    for (let i = 0; i < qty; i++) {
        await db.execute(
            "INSERT INTO inventory (product_type, branch, price, cost, profit, date) VALUES ($1, $2, $3, $4, $5, $6)",
            [wizardProductType, wizardBranch, price, cost, profit, today]
        );
    }

    closeAddWizard();
    loadItems();
    refreshSecondaryViewsIfVisible();
});

// Step 4b: Per Gram — "+ Add Product" appends another grams input row, each row's
// price is calculated live from grams x price-per-gram. "Save All Items" inserts
// one inventory row per filled-in row.
document.querySelector("#add-gram-row-btn").addEventListener("click", () => {
    const row = document.createElement("div");
    row.className = "gram-entry-row";

    const input = document.createElement("input");
    input.type = "number";
    input.step = "0.01";
    input.min = "0";
    input.placeholder = "grams";

    const priceSpan = document.createElement("span");
    priceSpan.className = "gram-entry-price";
    priceSpan.textContent = formatCurrency(0);

    input.addEventListener("input", () => {
        const grams = parseFloat(input.value) || 0;
        const pricePerGram = parseFloat(gramPricePerGramInput.value) || 0;
        priceSpan.textContent = formatCurrency(grams * pricePerGram);
    });

    row.appendChild(input);
    row.appendChild(priceSpan);
    gramEntriesList.appendChild(row);
    input.focus();
});

// Recalculate every row's price live if the price-per-gram value changes after
// some rows already have grams entered.
gramPricePerGramInput.addEventListener("input", () => {
    const pricePerGram = parseFloat(gramPricePerGramInput.value) || 0;
    gramEntriesList.querySelectorAll(".gram-entry-row").forEach(row => {
        const grams = parseFloat(row.querySelector("input").value) || 0;
        row.querySelector(".gram-entry-price").textContent = formatCurrency(grams * pricePerGram);
    });
});

document.querySelector("#save-gram-btn").addEventListener("click", async () => {
    const pricePerGram = parseFloat(gramPricePerGramInput.value) || 0;
    const today = new Date().toISOString().split("T")[0];
    const rows = gramEntriesList.querySelectorAll(".gram-entry-row");

    for (const row of rows) {
        const grams = parseFloat(row.querySelector("input").value) || 0;
        if (grams <= 0) continue; // Skip empty/unfilled rows
        const price = grams * pricePerGram;

        // No separate cost field for gram items: profit is recorded as the full
        // price so it still shows up correctly in Dashboard/Home profit totals.
        await db.execute(
            `INSERT INTO inventory
                (product_type, branch, price, cost, profit, date, weight_grams, price_per_gram)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [wizardProductType, wizardBranch, price, 0, price, today, grams, pricePerGram]
        );
    }

    closeAddWizard();
    loadItems();
    refreshSecondaryViewsIfVisible();
});

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
    document.querySelector("#sold-detail-branch").textContent = pendingSoldItem.branch || "—";
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
            (control_number, product_type, branch, price, cost, profit, date_added, date_sold,
             original_price, discount_type, discount_value, discount_amount)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
            pendingSoldItem.control_number,
            pendingSoldItem.product_type,
            pendingSoldItem.branch,
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
    const searchTerm = inventorySearchInput.value.trim().toLowerCase();
    if (searchTerm && !String(item.control_number).includes(searchTerm)) {
        return false;
    }

    const branchFilter = inventoryBranchSelect.value;
    if (branchFilter !== "all" && item.branch !== branchFilter) {
        return false;
    }

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
inventoryBranchSelect.addEventListener("change", applySortAndRender);
dateFromInput.addEventListener("change", applySortAndRender);
dateToInput.addEventListener("change", applySortAndRender);
inventorySearchInput.addEventListener("input", applySortAndRender);

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

        if (column === "product_type" || column === "branch") {
            valA = (valA || "").toLowerCase();
            valB = (valB || "").toLowerCase();
            if (valA < valB) return direction === "asc" ? -1 : 1;
            if (valA > valB) return direction === "asc" ? 1 : -1;
            return 0;
        }

        if (column === "date" || column === "date_added" || column === "date_sold") {
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

    const hasActiveFilter = productTypeSelect.value !== "all"
        || inventoryBranchSelect.value !== "all"
        || dateRangeSelect.value !== "all"
        || inventorySearchInput.value.trim() !== "";

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

        const branchCell = document.createElement("td");
        branchCell.textContent = item.branch || "—";

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
        row.appendChild(branchCell);
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
    currentExpenses = await db.select("SELECT * FROM expenses ORDER BY date DESC, id DESC");

    renderKpiCards(soldItems);
    renderBestSeller(soldItems);
    renderSalesTrendChart(soldItems);
}

function summarizePeriod(soldItems, startDateStr, endDateStr) {
    const inRange = soldItems.filter(item => {
        return item.date_sold >= startDateStr && item.date_sold <= endDateStr;
    });

    const revenue = inRange.reduce((sum, item) => sum + (Number(item.price) || 0), 0);
    const cost = inRange.reduce((sum, item) => sum + (Number(item.cost) || 0), 0);
    const grossProfit = inRange.reduce((sum, item) => sum + (Number(item.profit) || 0), 0);
    const expenses = sumExpensesInRange(startDateStr, endDateStr);
    const profit = grossProfit - expenses;

    return { count: inRange.length, revenue, cost, profit, expenses };
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

// ---------- Transactions ----------
async function loadTransactions() {
    currentSoldItems = await db.select("SELECT * FROM sold_items ORDER BY date_sold DESC, id DESC");
    applyTransactionsFilter();
}

function applyTransactionsFilter() {
    const term = transactionsSearchInput.value.trim().toLowerCase();
    const productFilter = transactionsProductTypeSelect.value;
    const branchFilter = transactionsBranchSelect.value;
    const dateMode = transactionsDateRangeSelect.value;

    let filtered = currentSoldItems;

    if (term) {
        filtered = filtered.filter(item => String(item.control_number).includes(term));
    }

    if (productFilter !== "all") {
        filtered = filtered.filter(item => item.product_type === productFilter);
    }

    if (branchFilter !== "all") {
        filtered = filtered.filter(item => item.branch === branchFilter);
    }

    if (dateMode !== "all") {
        const { todayStr, weekStartStr, monthStartStr, yearStartStr } = getDateBoundaries();

        filtered = filtered.filter(item => {
            const soldDate = item.date_sold;
            if (dateMode === "today") return soldDate === todayStr;
            if (dateMode === "week") return soldDate >= weekStartStr && soldDate <= todayStr;
            if (dateMode === "month") return soldDate >= monthStartStr && soldDate <= todayStr;
            if (dateMode === "year") return soldDate >= yearStartStr && soldDate <= todayStr;
            if (dateMode === "custom") {
                const from = transactionsDateFromInput.value;
                const to = transactionsDateToInput.value;
                if (from && soldDate < from) return false;
                if (to && soldDate > to) return false;
                return true;
            }
            return true;
        });
    }

    filtered = sortItems(filtered, transactionsSortState.column, transactionsSortState.direction);

    renderTransactionsTable(filtered);
    updateTransactionsSortIcons();
}
function updateTransactionsSortIcons() {
    transactionsSortableHeaders.forEach(th => {
        const icon = th.querySelector(".sort-icon");
        if (th.dataset.sort === transactionsSortState.column) {
            icon.textContent = transactionsSortState.direction === "desc" ? "▼" : "▲";
        } else {
            icon.textContent = "";
        }
    });
}

transactionsSortableHeaders.forEach(th => {
    th.addEventListener("click", () => {
        const column = th.dataset.sort;
        if (transactionsSortState.column === column) {
            transactionsSortState.direction = transactionsSortState.direction === "desc" ? "asc" : "desc";
        } else {
            transactionsSortState.column = column;
            transactionsSortState.direction = "desc";
        }
        applyTransactionsFilter();
    });
});

transactionsSearchInput.addEventListener("input", applyTransactionsFilter);
transactionsProductTypeSelect.addEventListener("change", applyTransactionsFilter);
transactionsBranchSelect.addEventListener("change", applyTransactionsFilter);

transactionsDateRangeSelect.addEventListener("change", () => {
    if (transactionsDateRangeSelect.value === "custom") {
        transactionsCustomDateFieldsWrapper.classList.remove("hidden");
    } else {
        transactionsCustomDateFieldsWrapper.classList.add("hidden");
    }
    applyTransactionsFilter();
});

transactionsDateFromInput.addEventListener("change", applyTransactionsFilter);
transactionsDateToInput.addEventListener("change", applyTransactionsFilter);

function renderTransactionsTable(soldItems) {
    transactionsTableBody.innerHTML = "";

    if (soldItems.length === 0) {
        transactionsEmptyState.classList.remove("hidden");
        transactionsEmptyState.textContent = currentSoldItems.length === 0
            ? "No products sold yet."
            : "No transactions match your search.";
        return;
    }
    transactionsEmptyState.classList.add("hidden");

    soldItems.forEach(item => {
        const row = document.createElement("tr");

        const idCell = document.createElement("td");
        idCell.textContent = item.control_number;

        const typeCell = document.createElement("td");
        typeCell.textContent = item.product_type;

        const branchCell = document.createElement("td");
        branchCell.textContent = item.branch || "—";

        const originalPriceCell = document.createElement("td");
        originalPriceCell.textContent = formatCurrency(item.original_price || item.price);

        const discountCell = document.createElement("td");
        discountCell.textContent = formatDiscount(item);

        const finalPriceCell = document.createElement("td");
        finalPriceCell.textContent = formatCurrency(item.price);

        const dateAddedCell = document.createElement("td");
        dateAddedCell.textContent = formatDate(item.date_added);

        const dateSoldCell = document.createElement("td");
        dateSoldCell.textContent = formatDate(item.date_sold);

        row.appendChild(idCell);
        row.appendChild(typeCell);
        row.appendChild(branchCell);
        row.appendChild(originalPriceCell);
        row.appendChild(discountCell);
        row.appendChild(finalPriceCell);
        row.appendChild(dateAddedCell);
        row.appendChild(dateSoldCell);

        transactionsTableBody.appendChild(row);
    });
}

// ---------- Reports (Expenses & Deposits) ----------
function openExpenseModal() {
    expenseForm.reset();
    expenseModalOverlay.classList.remove("hidden");
}
function closeExpenseModal() {
    expenseModalOverlay.classList.add("hidden");
    expenseForm.reset();
    expenseBranchWrapper.classList.remove("hidden");
}
openExpenseModalBtn.addEventListener("click", openExpenseModal);
closeExpenseModalBtn.addEventListener("click", closeExpenseModal);
cancelExpenseModalBtn.addEventListener("click", closeExpenseModal);
expenseModalOverlay.addEventListener("click", (e) => {
    if (e.target === expenseModalOverlay) closeExpenseModal();
});

expenseForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const branch = document.querySelector("#expense-branch").value;
    const transactionText = document.querySelector("#expense-transaction").value;
    const amount = parseFloat(document.querySelector("#expense-amount").value) || 0;
    const today = new Date().toISOString().split("T")[0];

    await db.execute(
        "INSERT INTO expenses (type, branch, transaction_text, amount, date) VALUES ($1, $2, $3, $4, $5)",
        ["expense", branch, transactionText, amount, today]
    );

    closeExpenseModal();
    loadReports();
    refreshSecondaryViewsIfVisible();
});

function openDepositModal() {
    depositForm.reset();
    depositModalOverlay.classList.remove("hidden");
}
function closeDepositModal() {
    depositModalOverlay.classList.add("hidden");
    depositForm.reset();
    depositBranchWrapper.classList.remove("hidden");
}
openDepositModalBtn.addEventListener("click", openDepositModal);
closeDepositModalBtn.addEventListener("click", closeDepositModal);
cancelDepositModalBtn.addEventListener("click", closeDepositModal);
depositModalOverlay.addEventListener("click", (e) => {
    if (e.target === depositModalOverlay) closeDepositModal();
});

depositForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const branch = document.querySelector("#deposit-branch").value;
    const amount = parseFloat(document.querySelector("#deposit-amount").value) || 0;
    const today = new Date().toISOString().split("T")[0];

    await db.execute(
        "INSERT INTO expenses (type, branch, transaction_text, amount, date) VALUES ($1, $2, $3, $4, $5)",
        ["deposit", branch, "", amount, today]
    );

    closeDepositModal();
    loadReports();
    refreshSecondaryViewsIfVisible();
});

reportsDateRangeSelect.addEventListener("change", () => {
    if (reportsDateRangeSelect.value === "custom") {
        reportsCustomDateFieldsWrapper.classList.remove("hidden");
    } else {
        reportsCustomDateFieldsWrapper.classList.add("hidden");
    }
    applyReportsFilter();
});
reportsBranchSelect.addEventListener("change", applyReportsFilter);
reportsDateFromInput.addEventListener("change", applyReportsFilter);
reportsDateToInput.addEventListener("change", applyReportsFilter);

async function loadReports() {
    currentExpenses = await db.select("SELECT * FROM expenses ORDER BY date DESC, id DESC");
    applyReportsFilter();
}

function applyReportsFilter() {
    const branchFilter = reportsBranchSelect.value;
    const dateMode = reportsDateRangeSelect.value;

    let filtered = currentExpenses;

    if (branchFilter !== "all") {
        filtered = filtered.filter(e => e.branch === branchFilter);
    }

    if (dateMode !== "all") {
        const { todayStr, weekStartStr, monthStartStr, yearStartStr } = getDateBoundaries();
        filtered = filtered.filter(e => {
            const d = e.date;
            if (dateMode === "today") return d === todayStr;
            if (dateMode === "week") return d >= weekStartStr && d <= todayStr;
            if (dateMode === "month") return d >= monthStartStr && d <= todayStr;
            if (dateMode === "year") return d >= yearStartStr && d <= todayStr;
            if (dateMode === "custom") {
                const from = reportsDateFromInput.value;
                const to = reportsDateToInput.value;
                if (from && d < from) return false;
                if (to && d > to) return false;
                return true;
            }
            return true;
        });
    }

    renderReportsActivity(filtered);
}

function renderReportsActivity(expenseItems) {
    reportsActivityList.innerHTML = "";

    if (expenseItems.length === 0) {
        reportsActivityEmpty.classList.remove("hidden");
        return;
    }
    reportsActivityEmpty.classList.add("hidden");

    expenseItems.forEach(entry => {
        const li = document.createElement("li");
        li.className = "activity-item";

        const icon = document.createElement("span");
        icon.className = "activity-icon " + (entry.type === "deposit" ? "activity-icon-added" : "activity-icon-sold");
        icon.textContent = entry.type === "deposit" ? "+" : "−";

        const text = document.createElement("span");
        text.className = "activity-text";
        text.textContent = entry.type === "deposit"
            ? `Deposit — ${entry.branch} — ${formatCurrency(entry.amount)}`
            : `Expense: ${entry.transaction_text} — ${entry.branch} — ${formatCurrency(entry.amount)}`;

        const dateSpan = document.createElement("span");
        dateSpan.className = "activity-date";
        dateSpan.textContent = formatDate(entry.date);

        li.appendChild(icon);
        li.appendChild(text);
        li.appendChild(dateSpan);
        reportsActivityList.appendChild(li);
    });
}

// Sums only 'expense' type rows (not deposits) within a date range — used to
// subtract expenses from Profit totals on Dashboard and Home.
function sumExpensesInRange(startDateStr, endDateStr) {
    return currentExpenses
        .filter(e => e.type === "expense" && e.date >= startDateStr && e.date <= endDateStr)
        .reduce((sum, e) => sum + (Number(e.amount) || 0), 0);
}


branchOpenSoldModalBtn.addEventListener("click", openSoldModal);

branchOpenExpenseModalBtn.addEventListener("click", () => {
    openExpenseModal();
    document.querySelector("#expense-branch").value = selectedBranch;
    expenseBranchWrapper.classList.add("hidden");
});

branchOpenDepositModalBtn.addEventListener("click", () => {
    openDepositModal();
    document.querySelector("#deposit-branch").value = selectedBranch;
    depositBranchWrapper.classList.add("hidden");
});



// ---------- Branch View ----------
async function loadBranchView() {
    if (!selectedBranch) return;
    branchViewTitle.textContent = `${selectedBranch} Branch`;

    const inventoryItems = await db.select(
        "SELECT * FROM inventory WHERE branch = $1 ORDER BY control_number DESC",
        [selectedBranch]
    );
    const soldItems = await db.select(
        "SELECT * FROM sold_items WHERE branch = $1 ORDER BY date_sold DESC, id DESC",
        [selectedBranch]
    );
    const expenseItems = await db.select(
        "SELECT * FROM expenses WHERE branch = $1 ORDER BY date DESC, id DESC",
        [selectedBranch]
    );
    const assignedUsers = await db.select(
        "SELECT name, role FROM users WHERE location = $1 OR location = 'Any' ORDER BY role",
        [selectedBranch]
    );

    renderBranchCashOnHand(soldItems, expenseItems);
    renderBranchStock(inventoryItems);
    renderBranchUsers(assignedUsers);
    renderBranchSold(soldItems);
    renderBranchExpenses(expenseItems);
}

function renderBranchCashOnHand(soldItems, expenseItems) {
    const cashIn = soldItems.reduce((sum, i) => sum + (Number(i.price) || 0), 0);
    const cashOut = expenseItems.reduce((sum, e) => sum + (Number(e.amount) || 0), 0); // expense + deposit both reduce cash
    branchCashOnHand.textContent = formatCurrency(cashIn - cashOut);
}

function renderBranchStock(inventoryItems) {
    branchStockCount.textContent = inventoryItems.length;
    branchInventoryList.innerHTML = "";

    if (inventoryItems.length === 0) {
        branchInventoryEmpty.classList.remove("hidden");
        return;
    }
    branchInventoryEmpty.classList.add("hidden");

    inventoryItems.forEach(item => {
        const row = document.createElement("tr");
        row.innerHTML = `
            <td>${item.control_number}</td>
            <td>${item.product_type}</td>
            <td>${formatCurrency(item.price)}</td>
            <td>${formatDate(item.date)}</td>
        `;
        branchInventoryList.appendChild(row);
    });
}

function renderBranchUsers(users) {
    branchUserList.innerHTML = "";
    if (users.length === 0) {
        branchUserList.innerHTML = "<li>No users assigned</li>";
        return;
    }
    users.forEach(u => {
        const li = document.createElement("li");
        li.textContent = `${u.name} (${u.role})`;
        branchUserList.appendChild(li);
    });
}

function renderBranchSold(soldItems) {
    branchSoldList.innerHTML = "";

    if (soldItems.length === 0) {
        branchSoldEmpty.classList.remove("hidden");
        return;
    }
    branchSoldEmpty.classList.add("hidden");

    soldItems.forEach(item => {
        const row = document.createElement("tr");
        row.innerHTML = `
            <td>${item.control_number}</td>
            <td>${item.product_type}</td>
            <td>${formatCurrency(item.price)}</td>
            <td>${formatDate(item.date_sold)}</td>
        `;
        branchSoldList.appendChild(row);
    });
}

function renderBranchExpenses(expenseItems) {
    branchExpensesList.innerHTML = "";

    if (expenseItems.length === 0) {
        branchExpensesEmpty.classList.remove("hidden");
        return;
    }
    branchExpensesEmpty.classList.add("hidden");

    expenseItems.forEach(entry => {
        const li = document.createElement("li");
        li.className = "activity-item";

        const icon = document.createElement("span");
        icon.className = "activity-icon activity-icon-sold";
        icon.textContent = entry.type === "deposit" ? "↓" : "−";

        const text = document.createElement("span");
        text.className = "activity-text";
        text.textContent = entry.type === "deposit"
            ? `Deposit — ${formatCurrency(entry.amount)}`
            : `Expense: ${entry.transaction_text} — ${formatCurrency(entry.amount)}`;

        const dateSpan = document.createElement("span");
        dateSpan.className = "activity-date";
        dateSpan.textContent = formatDate(entry.date);

        li.appendChild(icon);
        li.appendChild(text);
        li.appendChild(dateSpan);
        branchExpensesList.appendChild(li);
    });
}




// ---------- Home ----------
async function loadHome() {
    const inventoryItems = await db.select("SELECT * FROM inventory");
    const soldItems = await db.select("SELECT * FROM sold_items ORDER BY date_sold DESC, id DESC");
    currentExpenses = await db.select("SELECT * FROM expenses ORDER BY date DESC, id DESC");

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

    const grossProfitThisMonth = soldThisMonth.reduce((sum, i) => sum + (Number(i.profit) || 0), 0);
    const expensesThisMonth = sumExpensesInRange(monthStartStr, todayStr);
    const profitThisMonth = grossProfitThisMonth - expensesThisMonth;
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
        .reduce((sum, i) => sum + (Number(i.profit) || 0), 0) - sumExpensesInRange(weekStartStr, todayStr);
    const prevWeekProfit = soldItems
        .filter(i => i.date_sold >= prevWeekStartStr && i.date_sold <= prevWeekEndStr)
        .reduce((sum, i) => sum + (Number(i.profit) || 0), 0) - sumExpensesInRange(prevWeekStartStr, prevWeekEndStr);

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