const Database = window.__TAURI__.sql;
const db = await Database.load("sqlite:inventory.db");

const EXPECTED_COLUMNS = ["control_number", "product_type", "quantity", "price", "date"];

async function ensureInventoryTable() {
    // Does an "inventory" table already exist from an earlier version of the app?
    const existing = await db.select(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='inventory'"
    );

    if (existing.length > 0) {
        const columns = await db.select("PRAGMA table_info(inventory)");
        const columnNames = columns.map(c => c.name);
        const matches = EXPECTED_COLUMNS.every(col => columnNames.includes(col));

        if (!matches) {
            // Old schema doesn't match what this app expects.
            // Rename it instead of deleting, so no data is lost.
            const backupName = `inventory_backup_${Date.now()}`;
            await db.execute(`ALTER TABLE inventory RENAME TO ${backupName}`);
            console.warn(
                `Existing "inventory" table had a different schema. ` +
                `It was renamed to "${backupName}" and a new "inventory" table was created.`
            );
        }
    }

    await db.execute(`
        CREATE TABLE IF NOT EXISTS inventory (
            control_number INTEGER PRIMARY KEY AUTOINCREMENT,
            product_type TEXT,
            quantity INTEGER,
            price REAL,
            date TEXT
        )
    `);

    await db.execute(`
        CREATE TABLE IF NOT EXISTS sold_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            control_number INTEGER,
            product_type TEXT,
            quantity INTEGER,
            price REAL,
            date_added TEXT,
            date_sold TEXT
        )
    `);
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

// Holds the item currently pending sale confirmation.
let pendingSoldItem = null;

// Tracks which control_number is currently being edited.
// null means the modal is in "add new item" mode.
let editingControlNumber = null;

// Keeps the last-loaded items in memory so sorting doesn't need to re-query the DB.
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
    });
});

// ---------- Add / Edit Product Modal ----------
function openAddModal() {
    editingControlNumber = null;
    modalTitle.textContent = "Add Product";
    saveItemBtn.textContent = "Save Item";
    itemForm.reset();
    addModalOverlay.classList.remove("hidden");
    document.querySelector("#item-type").focus();
}

function openEditModal(item) {
    editingControlNumber = item.control_number;
    modalTitle.textContent = "Edit Product";
    saveItemBtn.textContent = "Update Item";

    document.querySelector("#item-type").value = item.product_type;
    document.querySelector("#item-qty").value = item.quantity;
    document.querySelector("#item-price").value = item.price;

    addModalOverlay.classList.remove("hidden");
    document.querySelector("#item-type").focus();
}

function closeAddModal() {
    addModalOverlay.classList.add("hidden");
    itemForm.reset();
    editingControlNumber = null;
    modalTitle.textContent = "Add Product";
    saveItemBtn.textContent = "Save Item";
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
    const priceInput = document.querySelector("#item-price");

    if (editingControlNumber === null) {
        // Adding a new item: date is captured automatically, not entered by the user.
        const today = new Date().toISOString().split("T")[0]; // YYYY-MM-DD

        await db.execute(
            "INSERT INTO inventory (product_type, quantity, price, date) VALUES ($1, $2, $3, $4)",
            [typeInput.value, parseInt(qtyInput.value), parseFloat(priceInput.value), today]
        );
    } else {
        // Editing an existing item: keep its original date, just update the details.
        await db.execute(
            "UPDATE inventory SET product_type = $1, quantity = $2, price = $3 WHERE control_number = $4",
            [typeInput.value, parseInt(qtyInput.value), parseFloat(priceInput.value), editingControlNumber]
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
    document.querySelector("#sold-detail-quantity").textContent = pendingSoldItem.quantity;
    document.querySelector("#sold-detail-price").textContent = formatCurrency(pendingSoldItem.price);
    document.querySelector("#sold-detail-date").textContent = formatDate(pendingSoldItem.date);

    soldLookupStep.classList.add("hidden");
    soldConfirmStep.classList.remove("hidden");
}

async function confirmSoldItem() {
    if (!pendingSoldItem) return;

    const dateSold = new Date().toISOString().split("T")[0];

    await db.execute(
        "INSERT INTO sold_items (control_number, product_type, quantity, price, date_added, date_sold) VALUES ($1, $2, $3, $4, $5, $6)",
        [
            pendingSoldItem.control_number,
            pendingSoldItem.product_type,
            pendingSoldItem.quantity,
            pendingSoldItem.price,
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

// ---------- Fetch + Sort + Render ----------
async function loadItems() {
    currentItems = await db.select("SELECT * FROM inventory");
    applySortAndRender();
}

function applySortAndRender() {
    const sorted = sortItems(currentItems, sortState.column, sortState.direction);
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

        // Numeric comparison for control_number, quantity, price, date
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
        return;
    }
    emptyState.classList.add("hidden");

    items.forEach(item => {
        const row = document.createElement("tr");

        const idCell = document.createElement("td");
        idCell.textContent = item.control_number;

        const typeCell = document.createElement("td");
        typeCell.textContent = item.product_type;

        const qtyCell = document.createElement("td");
        qtyCell.textContent = item.quantity;

        const priceCell = document.createElement("td");
        priceCell.textContent = formatCurrency(item.price);

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
        row.appendChild(qtyCell);
        row.appendChild(priceCell);
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