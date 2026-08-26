const customerForm = document.getElementById('customerForm');
const topupForm = document.getElementById('topupForm');

const paidupForm =
    document.getElementById('paidupForm');
const formMessage = document.getElementById('formMessage');
const topupMessage = document.getElementById('topupMessage');

const paidupMessage =
    document.getElementById('paidupMessage');

const headerSearchInput =
    document.getElementById("headerSearchInput");

const headerSearchBtn =
    document.getElementById("headerSearchBtn");


let recordsCache = [];
let currentLedgerData = null;

const deleteCustomerModal =
    document.getElementById("deleteCustomerModal");

const deleteCustomerName =
    document.getElementById("deleteCustomerName");

const deletePacketNo =
    document.getElementById("deletePacketNo");

const deleteConfirmInput =
    document.getElementById("deleteConfirmInput");

const cancelDeleteBtn =
    document.getElementById("cancelDeleteBtn");

const confirmDeleteBtn =
    document.getElementById("confirmDeleteBtn");

const successToast =
    document.getElementById("successToast");

const errorToast =
    document.getElementById("errorToast");

async function fetchRecords(filters = {}) {
  const params = new URLSearchParams();
  if (filters.party) params.set('party', filters.party);
  if (filters.packetNo) params.set('packetNo', filters.packetNo);
  if (filters.name) params.set('name', filters.name);

  const query = params.toString();
  const data = await apiRequest(`/api/records${query ? `?${query}` : ''}`);
  return data.records;
}


async function fetchLedger(filters = {}) {

    const params = new URLSearchParams();

    if (filters.party)
        params.set('party', filters.party);

    if (filters.packetNo)
        params.set('packetNo', filters.packetNo);

    if (filters.name)
        params.set('name', filters.name);

    const query = params.toString();

    return await apiRequest(
        `/api/ledger${query ? `?${query}` : ''}`
    );

}

function parseDate(dateStr) {
  return new Date(dateStr + 'T00:00:00');
}

function daysExclusive(start, end) {
  const ms = parseDate(end) - parseDate(start);
  return Math.max(0, Math.round(ms / (1000 * 60 * 60 * 24)));
}

function daysInclusive(start, end) {
  return daysExclusive(start, end) + 1;
}

function formatCurrency(amount) {
  return '₹' + Number(amount).toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

function formatPdfCurrency(amount) {

    return "Rs. " +
        Number(amount).toLocaleString(
            "en-IN",
            {
                maximumFractionDigits: 2
            }
        );

}

function formatDate(dateStr) {
  const d = parseDate(dateStr);
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}


function calculateInterestAmount(
  amount,
  roi,
  startDate,
  endDate,
  includeLastDay = false
) {

  if (!startDate || !endDate) return 0;

  const days = includeLastDay
    ? daysInclusive(startDate, endDate)
    : daysExclusive(startDate, endDate);


  return (
    Number(amount) *
    Number(roi) *
    days
  ) / (100 * 30);

}

function calculateInterestForPeriod(record, startDate, endDate) {

    const roi = Number(record.rateOfInterest);

    let principal = Number(record.amount);

    const transactions = [];

    (record.topUps || []).forEach(topup => {
        transactions.push({
            type: 'TOPUP',
            date: topup.date,
            amount: Number(topup.amount)
        });
    });

    (record.paidUps || []).forEach(paidup => {
        transactions.push({
            type: 'PAIDUP',
            date: paidup.date,
            amount: Number(paidup.amount)
        });
    });

    transactions.sort((a, b) => new Date(a.date) - new Date(b.date));

    // Bring principal to the value on startDate
    for (const tx of transactions) {
        if (new Date(tx.date) < new Date(startDate)) {
            if (tx.type === 'TOPUP')
                principal += tx.amount;
            else
                principal -= tx.amount;
        }
    }

    let currentDate = startDate;
    let totalInterest = 0;

    for (const tx of transactions) {

        if (
            new Date(tx.date) < new Date(startDate) ||
            new Date(tx.date) > new Date(endDate)
        )
            continue;

        const days =
          Math.floor(
              (new Date(tx.date) - new Date(currentDate))
              / (1000 * 60 * 60 * 24)
          ) + 1;

        totalInterest +=
            (principal * roi * days) / (100 * 30);

        if (tx.type === 'TOPUP')
            principal += tx.amount;
        else
            principal -= tx.amount;

        currentDate = tx.date;
    }

    const remainingDays =
        Math.floor(
            (new Date(endDate) - new Date(currentDate))
            / (1000 * 60 * 60 * 24)
        ) + 1;

    totalInterest +=
        (principal * roi * remainingDays)
        / (100 * 30);

    return totalInterest;
}

function showMessage(el, text, type) {
  el.textContent = text;
  el.className = `message ${type}`;
  el.hidden = false;
  setTimeout(() => {
    el.hidden = true;
  }, 4000);
}


function renderCustomerSummary(record) {

    return `

    <article class="ledger-customer-card">

        <div class="ledger-header">

            <div>
                <h3>${record.customerName}</h3>

                <p>
                    Packet No. ${record.packetNo}
                </p>
            </div>

            <div class="ledger-header-actions">

                <button
                    class="btn download-pdf-btn"
                    id="downloadPdfBtn">

                    <span class="pdf-icon">📄</span>

                    Download PDF

                </button>

                <span class="status-badge ${record.status.toLowerCase()}">
                    ${record.status}
                </span>

            </div>

        </div>

        <div class="ledger-customer-grid">

            <div>
                <label>Party</label>
                <span>${record.party}</span>
            </div>

            <div>
                <label>Phone</label>
                <span>${record.phoneNumber}</span>
            </div>

            <div>
                <label>Item</label>
                <span>${record.item}</span>
            </div>

            <div>
                <label>Item Name</label>
                <span>${record.itemName}</span>
            </div>

            <div>
                <label>Weight</label>
                <span>${record.weight} gm</span>
            </div>

            <div>
                <label>Quantity</label>
                <span>${record.quantity}</span>
            </div>

            <div>
                <label>Entry Date</label>
                <span>${formatDate(record.entryDate)}</span>
            </div>

            <div>
                <label>ROI</label>
                <span>${record.rateOfInterest}%</span>
            </div>

        </div>

        <div class="ledger-delete-container">

            <button
                class="delete-customer-btn"
                id="deleteCustomerBtn">

                🗑 Delete Customer

            </button>

        </div>

    </article>

    `;
}


function renderLoanSummary(summary) {

    const currentPrincipal = summary.currentPrincipal;

    const interestPaid = summary.totalInterestPaid;

    return `

    <section class="ledger-summary">

        <div class="ledger-summary-card">

            <label>Current Principal</label>

            <h3>${formatCurrency(currentPrincipal)}</h3>

        </div>

        <div class="ledger-summary-card">

            <label>Interest Paid</label>

            <h3>${formatCurrency(interestPaid)}</h3>

        </div>

        <div class="ledger-summary-card">

            <label>Top-Ups</label>

            <h3>${summary.topupCount}</h3>

        </div>

        <div class="ledger-summary-card">

            <label>Paid-Ups</label>

            <h3>${summary.paidupCount}</h3>

        </div>

    </section>

    `;

}

function renderLedgerTimeline(timeline) {

    if (!timeline || timeline.length === 0) {

        return `
            <p class="empty-state">
                No transactions found.
            </p>
        `;

    }

    return `
        <section class="ledger-timeline">

            ${timeline.map(event => {

                let details = '';

                switch (event.type) {

                    case 'ENTRY':

                        details = `
                        <div>
                            <label>Principal</label>
                            <span>${formatCurrency(event.principal)}</span>
                        </div>
                        `;
                        break;

                    case 'TOPUP':

                        details = `
                        <div>
                            <label>Amount Added</label>
                            <span>${formatCurrency(event.amount)}</span>
                        </div>

                        <div>
                            <label>Principal After</label>
                            <span>${formatCurrency(event.principalAfter)}</span>
                        </div>
                        `;
                        break;

                    case 'PAIDUP':

                        details = `
                        <div>
                            <label>Amount Paid</label>
                            <span>${formatCurrency(event.amount)}</span>
                        </div>

                        <div>
                            <label>Principal After</label>
                            <span>${formatCurrency(event.principalAfter)}</span>
                        </div>
                        `;
                        break;

                    case 'INTEREST':

                        details = `
                        <div>
                            <label>Interest Paid</label>
                            <span>${formatCurrency(event.amount)}</span>
                        </div>

                        <div>
                            <label>Paid Till</label>
                            <span>${formatDate(event.paidTill)}</span>
                        </div>
                        `;
                        break;

                    case 'RELEASE':

                        details = `
                        <div>
                            <label>Principal Paid</label>
                            <span>${formatCurrency(event.principalPaid)}</span>
                        </div>

                        <div>
                            <label>Interest Paid</label>
                            <span>${formatCurrency(event.interestPaid)}</span>
                        </div>

                        <div>
                            <label>Total Paid</label>
                            <span>${formatCurrency(event.totalPaid)}</span>
                        </div>
                        `;
                        break;

                }

                return `

                <div class="ledger-event ${event.type.toLowerCase()}">

                    <div class="ledger-event-header">

                        <div class="ledger-event-title">
                            ${event.title}
                        </div>

                        <div class="ledger-event-date">
                            ${formatDate(event.date)}
                        </div>

                    </div>

                    <div class="ledger-event-grid">

                        ${details}

                    </div>

                </div>

                `;

            }).join('')}

        </section>
    `;

}

function downloadLedgerPDF() {

    if (!currentLedgerData) {
        alert("No customer loaded.");
        return;
    }

    const { jsPDF } = window.jspdf;

    const pdf = new jsPDF({
        orientation: "portrait",
        unit: "mm",
        format: "a4"
    });

    const record = currentLedgerData.record;
    const summary = currentLedgerData.summary;
    const timeline = currentLedgerData.timeline;

    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(20);
    pdf.text("MANIBHADRA JEWELLERS", 105, 18, {
        align: "center"
    });

    pdf.setFontSize(14);
    pdf.text("Customer Loan Ledger", 105, 27, {
        align: "center"
    });

    pdf.setLineWidth(0.5);
    pdf.line(15, 32, 195, 32);

    let y = 38;

    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(13);
    pdf.text("Customer Information", 15, y);

    y += 8;

    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(11);

    const leftX = 15;
    const rightX = 110;

    pdf.text(`Customer : ${record.customerName}`, leftX, y);
    pdf.text(`Packet : ${record.packetNo}`, rightX, y);

    y += 7;

    pdf.text(`Party : ${record.party}`, leftX, y);
    pdf.text(`Phone : ${record.phoneNumber}`, rightX, y);

    y += 7;

    pdf.text(`Item : ${record.item}`, leftX, y);
    pdf.text(`Status : ${record.status}`, rightX, y);

    y += 7;

    pdf.text(`Item Name : ${record.itemName}`, leftX, y);
    pdf.text(`ROI : ${record.rateOfInterest}%`, rightX, y);

    y += 7;

    pdf.text(`Weight : ${record.weight} gm`, leftX, y);
    pdf.text(`Quantity : ${record.quantity}`, rightX, y);

    y += 10;

    pdf.setDrawColor(180);
    pdf.line(15, y, 195, y);

    y += 10;

    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(13);
    pdf.text("Loan Summary", 15, y);

    y += 8;

    pdf.setFont("courier", "normal");
    pdf.setFontSize(11);

    pdf.text(
        `Original Loan Amount : ${formatPdfCurrency(record.amount)}`,
        15,
        y
    );

    y += 7;

    pdf.text(
        `Current Principal : ${formatPdfCurrency(summary.currentPrincipal)}`,
        15,
        y
    );

    y += 7;

    pdf.text(
        `Interest Paid : ${formatPdfCurrency(summary.totalInterestPaid)}`,
        15,
        y
    );

    y += 7;

    pdf.text(
        `Top-Ups : ${summary.topupCount}`,
        15,
        y
    );

    y += 7;

    pdf.text(
        `Paid-Ups : ${summary.paidupCount}`,
        15,
        y
    );

    y += 10;

    pdf.setDrawColor(180);
    pdf.line(15, y, 195, y);

    y += 10;

    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(13);
    pdf.text("Transaction History", 15, y);

    y += 6;

    const tableRows = [];

    timeline.forEach(event => {

        let amount = "";
        let principalAfter = "";

        switch (event.type) {

            case "ENTRY":
                amount = formatPdfCurrency(event.principal);
                principalAfter = formatPdfCurrency(event.principalAfter);
                break;

            case "TOPUP":
                amount = formatPdfCurrency(event.amount);
                principalAfter = formatPdfCurrency(event.principalAfter);
                break;

            case "PAIDUP":
                amount = formatPdfCurrency(event.amount);
                principalAfter = formatPdfCurrency(event.principalAfter);
                break;

            case "INTEREST":
                amount = formatPdfCurrency(event.amount);
                principalAfter = formatPdfCurrency(event.principalAfter);
                break;

            case "RELEASE":
                amount = formatPdfCurrency(event.totalPaid);
                principalAfter = "Released";
                break;
        }

        tableRows.push([
            formatDate(event.date),
            event.title,
            amount,
            principalAfter
        ]);

    });

    pdf.autoTable({

        startY: y + 4,

        head: [[
            "Date",
            "Transaction",
            "Amount",
            "Principal After"
        ]],

        body: tableRows,

        theme: "striped",

        tableWidth: "auto",

        headStyles: {
            fillColor: [45, 45, 45],
            textColor: 255,
            fontStyle: "bold",
            halign: "center"
        },

        alternateRowStyles: {
            fillColor: [245, 245, 245]
        },

        styles: {

            fontSize: 9,

            cellPadding: 2.5,

            overflow: "linebreak",

            valign: "middle"

        },

        columnStyles: {

            0: {
                cellWidth: 35,
                halign: "center"
            },

            1: {
                cellWidth: 55,
                halign: "center"
            },

            2: {
                cellWidth: 45,
                halign: "right"
            },

            3: {
                cellWidth: 45,
                halign: "right"
            }

        },

    });

    y = pdf.lastAutoTable.finalY + 10;

    pdf.setFont("helvetica", "italic");
    pdf.setFontSize(9);

    pdf.text(
        `Generated on: ${new Date().toLocaleString("en-IN")}`,
        15,
        287
    );

    pdf.save(`Packet_${record.packetNo}.pdf`);

}

function openDeleteModal(record) {

    deleteCustomerName.textContent =
        record.customerName;

    deletePacketNo.textContent =
        record.packetNo;

    deleteConfirmInput.value = "";

    confirmDeleteBtn.disabled = true;

    deleteCustomerModal.classList.remove("hidden");

    deleteConfirmInput.focus();
}


function closeDeleteModal() {

    deleteCustomerModal.classList.add("hidden");

    deleteConfirmInput.value = "";

    deleteConfirmInput.blur();

    confirmDeleteBtn.disabled = true;

    confirmDeleteBtn.textContent = "Delete Customer";

}


function showSuccessToast(message) {

    successToast.textContent = message;

    successToast.classList.add("show");

    setTimeout(() => {

        successToast.classList.remove("show");

    }, 3000);
}

function showErrorToast(message) {

    errorToast.textContent = message;

    errorToast.classList.add("show");

    setTimeout(() => {

        errorToast.classList.remove("show");

    }, 3000);

}


function validateDeleteInput() {

    if (!currentLedgerData)
        return;

    const expected =
        String(currentLedgerData.record.packetNo);

    const entered =
        deleteConfirmInput.value.trim();

    confirmDeleteBtn.disabled =
        entered !== expected;
}


async function confirmDeleteCustomer() {

    if (!currentLedgerData)
        return;

    const record = currentLedgerData.record;

    openDeleteModal(record);

    return;

    try {

        const response = await fetch("/api/customer", {
            method: "DELETE",
            credentials: "include",
            headers: {
                "Content-Type": "application/json",
                "X-CSRF-Token": csrfToken
            },
            body: JSON.stringify({
                party: record.party,
                packetNo: record.packetNo
            })
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error || "Failed to delete customer.");
        }

        alert("Customer deleted successfully.");

        currentLedgerData = null;

        document.getElementById("searchResults").innerHTML = `
            <p class="empty-state">
                Search a customer to view the complete ledger.
            </p>
        `;

    }
    catch (err) {

        alert(err.message);

    }

}

async function deleteCustomer() {

    if (!currentLedgerData)
        return;

    const record = currentLedgerData.record;

    confirmDeleteBtn.disabled = true;

    confirmDeleteBtn.textContent = "Deleting...";

    try {

        const response = await fetch("/api/customer", {

            method: "DELETE",

            credentials: "include",

            headers: {

                "Content-Type": "application/json",

                "X-CSRF-Token": csrfToken

            },

            body: JSON.stringify({

                party: record.party,

                packetNo: record.packetNo

            })

        });

        const data = await response.json();

        if (!response.ok) {

            throw new Error(
                data.error || "Failed to delete customer."
            );

        }


        confirmDeleteBtn.textContent = "Delete Customer";

        confirmDeleteBtn.disabled = false;

        closeDeleteModal();

        showSuccessToast(
            "✔ Customer deleted successfully."
        );

        currentLedgerData = null;

        document.getElementById("searchResults").innerHTML = `

            <p class="empty-state">

                Search a customer to view the complete ledger.

            </p>

        `;

    }

    catch (err) {

        confirmDeleteBtn.textContent = "Delete Customer";

        validateDeleteInput();

        closeDeleteModal();

        showErrorToast(err.message);

    }

}

async function loadLedger(packetNo, party) {

    const data = await fetchLedger({
        packetNo,
        party
    });

    currentLedgerData = data;

    if (!data.record)
        return;

    document.getElementById('searchResults').innerHTML =

        renderCustomerSummary(data.record)

        +

        renderLoanSummary(data.summary)

        +

        renderLedgerTimeline(data.timeline);

    document
        .getElementById("downloadPdfBtn")
        ?.addEventListener("click", downloadLedgerPDF);

    document
        .getElementById("deleteCustomerBtn")
        ?.addEventListener("click", confirmDeleteCustomer);

}

function renderLedgerSearchResults(records) {

    if (records.length === 0) {

        return `
            <p class="empty-state">
                No customers found.
            </p>
        `;

    }

    return records.map(record => `

        <div class="record-card ledger-search-card"
             data-packet="${record.packetNo}"
             data-party="${record.party}">

            <h3>

                ${record.customerName}

                <span class="record-badges">

                    <span class="party-badge">
                        ${record.party}
                    </span>

                    <span class="status-badge ${record.status.toLowerCase()}">
                        ${record.status}
                    </span>

                </span>

            </h3>

            <div class="record-grid">

                <div>
                    <dt>Packet</dt>
                    <dd>${record.packetNo}</dd>
                </div>

                <div>
                    <dt>Phone</dt>
                    <dd>${record.phoneNumber}</dd>
                </div>

                <div>
                    <dt>Item</dt>
                    <dd>${record.item}</dd>
                </div>

            </div>

        </div>

    `).join('');

}



function renderInterestHistory(history) {

  const container = document.getElementById('interestHistory');

  if (history.length === 0) {

    container.innerHTML = `
        <p class="empty-state">
            No Interest Payment history.
        </p>
    `;

    return;
}

  container.innerHTML = `

      <table class="history-table">

          <thead>

              <tr>

                  <th>Payment Date</th>

                  <th>Interest Start</th>

                  <th>Interest Paid Till</th>

                  <th>Interest Paid</th>

              </tr>

          </thead>

          <tbody>

              ${history.map(item => `

                  <tr>

                      <td>${formatDate(item.payment_date)}</td>

                      <td>${formatDate(item.interest_start_date)}</td>

                      <td>${formatDate(item.interest_paid_till)}</td>

                      <td>${formatCurrency(item.interest_amount)}</td>

                  </tr>

              `).join('')}

          </tbody>

      </table>

  `;

}

function renderTopupHistory(record) {

    const container =
        document.getElementById('topupHistory');

    if (!record.topUps || record.topUps.length === 0) {

        container.innerHTML =
            '<p class="empty-state">No Top-Up history.</p>';

        return;

    }

    let html = `
        <table class="history-table">
            <thead>
                <tr>
                    <th>Date</th>
                    <th>Top-Up Amount</th>
                </tr>
            </thead>
            <tbody>
    `;

    record.topUps.forEach(item => {

        html += `
            <tr>
                <td>${formatDate(item.date)}</td>
                <td>${formatCurrency(item.amount)}</td>
            </tr>
        `;

    });

    html += `
            </tbody>
        </table>
    `;

    container.innerHTML = html;

}



function renderPaidupHistory(record) {

    const container =
        document.getElementById('paidupHistory');

    if (!record.paidUps || record.paidUps.length === 0) {

        container.innerHTML =
            '<p class="empty-state">No Paid-Up history.</p>';

        return;

    }

    let html = `
        <table class="history-table">
            <thead>
                <tr>
                    <th>Date</th>
                    <th>Paid-Up Amount</th>
                </tr>
            </thead>
            <tbody>
    `;

    record.paidUps.forEach(item => {

        html += `
            <tr>
                <td>${formatDate(item.date)}</td>
                <td>${formatCurrency(item.amount)}</td>
            </tr>
        `;

    });

    html += `
            </tbody>
        </table>
    `;

    container.innerHTML = html;

}


function getCurrentPrincipal(record) {

    const timeline = buildTransactionTimeline(record);

    let principal = 0;

    timeline.forEach(transaction => {

        switch (transaction.type) {

            case 'ENTRY':
                principal = transaction.amount;
                break;

            case 'TOPUP':
                principal += transaction.amount;
                break;

            case 'PAIDUP':
                principal -= transaction.amount;
                break;

        }

    });

    return principal;

}

function buildTransactionTimeline(record) {

    const timeline = [];

    // Original Loan Entry
    timeline.push({
        type: 'ENTRY',
        date: record.entryDate,
        amount: Number(record.amount)
    });

    // Interest Payments
    if (record.interestPayments) {

        record.interestPayments.forEach(payment => {

            timeline.push({
                type: 'INTEREST_PAYMENT',
                date: payment.date,
                amount: Number(payment.amount),
                interestPaidTill: payment.interestPaidTill
            });

        });

    }

    // Top-Ups
    if (record.topUps) {

        record.topUps.forEach(topup => {

            timeline.push({
                type: 'TOPUP',
                date: topup.date,
                amount: Number(topup.amount)
            });

        });

    }

    // Paid-Ups
    if (record.paidUps) {

        record.paidUps.forEach(paidup => {

            timeline.push({
                type: 'PAIDUP',
                date: paidup.date,
                amount: Number(paidup.amount)
            });

        });

    }

    // Release
    if (record.releaseDate) {

        timeline.push({
            type: 'RELEASE',
            date: record.releaseDate
        });

    }

    timeline.sort((a, b) => {

        const dateDiff =
            new Date(a.date) - new Date(b.date);

        if (dateDiff !== 0)
            return dateDiff;

        const order = {
            ENTRY: 1,
            INTEREST_PAYMENT: 2,
            TOPUP: 3,
            PAIDUP: 4,
            RELEASE: 5
        };

        return order[a.type] - order[b.type];

    });

    return timeline;

}

function setupEventListeners() {

  deleteConfirmInput.addEventListener(
      "input",
      validateDeleteInput
  );

  cancelDeleteBtn.addEventListener(
      "click",
      closeDeleteModal
  );

  confirmDeleteBtn.addEventListener(
      "click",
      deleteCustomer
  );

  deleteCustomerModal.addEventListener(
      "click",
      (e) => {

          if (e.target === deleteCustomerModal) {

              closeDeleteModal();

          }

      }
  );

  customerForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    const party = document.getElementById('partySelect').value;
    const payload = {
      party,
      packetNo: Number(document.getElementById('packetNo').value),
      customerName: document.getElementById('customerName').value.trim(),
      phoneNumber: document.getElementById('phoneNumber').value.trim(),
      item: document.getElementById('item').value,
      itemName: document.getElementById('itemName').value.trim(),
      amount: Number(document.getElementById('amount').value),
      quantity: Number(document.getElementById('quantity').value),
      weight: Number(document.getElementById('weight').value),
      entryDate: document.getElementById('entryDate').value,
      rateOfInterest: Number(document.getElementById('rateOfInterest').value),
    };

    try {
      await apiRequest('/api/records', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      customerForm.reset();
      showMessage(formMessage, `Record saved for ${payload.customerName} (Packet ${payload.packetNo}).`, 'success');
    } catch (err) {
      showMessage(formMessage, err.message, 'error');
    }
  });


  async function performHeaderSearch() {

      const query = headerSearchInput.value.trim();

      if (!query)
          return;

      // Open Ledger page automatically
      openTab("search");

      const resultsEl =
          document.getElementById("searchResults");

      try {

          const filters = {
              party: document.getElementById("partySelect").value
          };

          if (/^\d+$/.test(query)) {

              filters.packetNo = query;

              const data = await fetchLedger(filters);

              if (!data.record) {

                  resultsEl.innerHTML =
                      '<p class="empty-state">No record found matching your search.</p>';

                  return;

              }

              currentLedgerData = data;

              resultsEl.innerHTML =
                  renderCustomerSummary(data.record) +
                  renderLoanSummary(data.summary) +
                  renderLedgerTimeline(data.timeline);

              document
                  .getElementById("downloadPdfBtn")
                  ?.addEventListener("click", downloadLedgerPDF);

              document
                  .getElementById("deleteCustomerBtn")
                  ?.addEventListener("click", confirmDeleteCustomer);

          } else {

              filters.name = query;

              const data = await fetchLedger(filters);

              resultsEl.innerHTML =
                  renderLedgerSearchResults(data.records);

              document
                  .querySelectorAll(".ledger-search-card")
                  .forEach(card => {

                      card.addEventListener("click", () => {

                          loadLedger(
                              card.dataset.packet,
                              card.dataset.party
                          );

                      });

                  });

          }

      } catch (err) {

          resultsEl.innerHTML =
              `<p class="empty-state">${err.message}</p>`;

      }

  }

  headerSearchBtn.addEventListener(
      "click",
      performHeaderSearch
  );

  headerSearchInput.addEventListener(
      "keydown",
      (e) => {

          if (e.key === "Enter") {

              e.preventDefault();

              performHeaderSearch();

          }

      }
  );
  document.getElementById('clearSearchBtn').addEventListener('click', () => {

      headerSearchInput.value = "";

      currentLedgerData = null;

      document.getElementById("searchResults").innerHTML =
          '<p class="empty-state">Search a customer to view the complete ledger.</p>';

  });

  headerSearchInput.value = "";



  // ===============================
  // TOP-UP SEARCH
  // ===============================

  const topupSearchBtn =
    document.getElementById('topupSearchBtn');

  const topupClearBtn =
    document.getElementById('topupClearBtn');

  const paidupSearchBtn =
      document.getElementById('paidupSearchBtn');

  const paidupClearBtn =
      document.getElementById('paidupClearBtn');



  topupClearBtn.addEventListener('click', () => {

    currentTopupRecord = null;

    document.getElementById('topupPacketNo').value = '';

    document.getElementById('topupForm').reset();

    document.getElementById('topupForm').hidden = true;

    document.getElementById('topupMessage').hidden = true;

    document.getElementById('topupHistory').innerHTML =
      '<p class="empty-state">Search a customer to view Top-Up history.</p>';

    document.getElementById('principalBeforeTopup').value = '';

    document.getElementById('principalAfterTopup').value = '';

    document.getElementById('topupPacketNo').focus();

  });


  paidupClearBtn.addEventListener('click', () => {

    currentPaidupRecord = null;

    document.getElementById('paidupPacketNo').value = '';

    document.getElementById('paidupForm').reset();

    document.getElementById('paidupForm').hidden = true;

    document.getElementById('paidupMessage').hidden = true;

    document.getElementById('paidupHistory').innerHTML =
      '<p class="empty-state">Search a customer to view Paid-Up history.</p>';

    document.getElementById('principalBeforePaidup').value = '';

    document.getElementById('principalAfterPaidup').value = '';

    document.getElementById('paidupPacketNo').focus();

  });


  let currentTopupRecord = null;

  let currentPaidupRecord = null;

  document
    .getElementById('topupAmount')
    .addEventListener('input', () => {

      if (!currentTopupRecord) return;

      const addition =
        Number(
          document.getElementById('topupAmount').value
        ) || 0;

      document.getElementById(
        'principalAfterTopup'
      ).value =
        getCurrentPrincipal(currentTopupRecord) + addition

    });


  document
    .getElementById('paidupAmount')
    .addEventListener('input', () => {

      if (!currentPaidupRecord) return;

      const deduction =
        Number(
          document.getElementById('paidupAmount').value
        ) || 0;

      document.getElementById(
        'principalAfterPaidup'
      ).value =
        getCurrentPrincipal(currentPaidupRecord) - deduction

    });


  async function loadCustomerForTransaction(packetNo, party) {

    const records = await fetchRecords({
      party,
      packetNo
    });

    if (records.length === 0) {
      return null;
    }

    return records[0];

  }

  topupSearchBtn.addEventListener('click', async () => {


    const packetNo = Number(
      document.getElementById('topupPacketNo').value
    );

    const party =
      document.getElementById('partySelect').value;

    if (!packetNo) {

      showMessage(
        topupMessage,
        'Enter a packet number.',
        'error'
      );

      return;

    }

    try {

      currentTopupRecord =
        await loadCustomerForTransaction(packetNo, party);

        console.log(buildTransactionTimeline(currentTopupRecord));

      if (!currentTopupRecord) {

        document.getElementById('topupForm').hidden = true;

        showMessage(
          topupMessage,
          'Customer not found.',
          'error'
        );

        return;

      }

      if (currentTopupRecord.status === 'RELEASED') {

        document.getElementById('topupForm').hidden = true;

        showMessage(
          topupMessage,
          'This customer has already been released.',
          'error'
        );

        return;

      }


      document.getElementById('topupCustomerName').value =
        currentTopupRecord.customerName;

      document.getElementById('topupPhoneNumber').value =
        currentTopupRecord.phoneNumber;

      const currentPrincipal =
          getCurrentPrincipal(currentTopupRecord);

      document.getElementById('topupCurrentAmount').value =
          currentPrincipal;

      document.getElementById('topupROI').value =
          currentTopupRecord.rateOfInterest;

      document.getElementById('topupEntryDate').value =
          currentTopupRecord.entryDate;

      const params = new URLSearchParams({
          party,
          packetNo
      });

      const interestData = await apiRequest(
          `/api/interest-payment/search?${params.toString()}`
      );

      document.getElementById('topupLastInterestPaid').value =
          interestData.lastInterestPaidTill || 'Interest not paid yet';

      document.getElementById('principalBeforeTopup').value =
          currentPrincipal;

      document.getElementById('principalAfterTopup').value =
          currentPrincipal;



      document.getElementById('topupForm').hidden = false;

      document.getElementById('topupDate').value =
        new Date().toISOString().split('T')[0];

      renderTopupHistory(currentTopupRecord);

    }

    catch (err) {

      console.error("Top-Up Search Error:", err);

      document.getElementById('topupForm').hidden = true;

      showMessage(
        topupMessage,
        err.message,
        'error'
      );

    }

  });


  paidupSearchBtn.addEventListener('click', async () => {


    const packetNo = Number(
      document.getElementById('paidupPacketNo').value
    );

    const party =
      document.getElementById('partySelect').value;

    if (!packetNo) {

      showMessage(
        paidupMessage,
        'Enter a packet number.',
        'error'
      );

      return;

    }

    try {

      currentPaidupRecord =
        await loadCustomerForTransaction(packetNo, party);

      if (!currentPaidupRecord) {

        document.getElementById('paidupForm').hidden = true;

        showMessage(
          paidupMessage,
          'Customer not found.',
          'error'
        );

        return;

      }

      if (currentPaidupRecord.status === 'RELEASED') {

        document.getElementById('paidupForm').hidden = true;

        showMessage(
          paidupMessage,
          'This customer has already been released.',
          'error'
        );

        return;

      }


      document.getElementById('paidupCustomerName').value =
        currentPaidupRecord.customerName;

      document.getElementById('paidupPhoneNumber').value =
        currentPaidupRecord.phoneNumber;

      const currentPrincipal =
          getCurrentPrincipal(currentPaidupRecord);

      document.getElementById('paidupCurrentAmount').value =
          currentPrincipal;

      document.getElementById('paidupROI').value =
          currentPaidupRecord.rateOfInterest;

      document.getElementById('paidupEntryDate').value =
          currentPaidupRecord.entryDate;

      const params = new URLSearchParams({
          party,
          packetNo
      });

      const interestData = await apiRequest(
          `/api/interest-payment/search?${params.toString()}`
      );

      document.getElementById('paidupLastInterestPaid').value =
          interestData.lastInterestPaidTill || 'Interest not paid yet';

      document.getElementById('principalBeforePaidup').value =
          currentPrincipal;

      document.getElementById('principalAfterPaidup').value =
          currentPrincipal;



      document.getElementById('paidupForm').hidden = false;

      document.getElementById('paidupDate').value =
        new Date().toISOString().split('T')[0];

      renderPaidupHistory(currentPaidupRecord);

      console.log(
        document.getElementById('paidupForm').hidden
      );

    }

    catch (err) {

      console.error("Paid-Up Search Error:", err);

      document.getElementById('paidupForm').hidden = true;

      showMessage(
        paidupMessage,
        err.message,
        'error'
      );

    }

    });
  // ===============================
  // REPORTS
  // ===============================

  const reportToggleButtons =
    document.querySelectorAll('.report-toggle-btn');

  const reportDateInput =
    document.getElementById('reportTillDate');

  const reportSummary =
    document.getElementById('reportSummary');

  const reportTableContainer =
    document.getElementById('reportTableContainer');

  const reportTableTitle =
    document.getElementById('reportTableTitle');

  const reportDateLabel =
    document.getElementById('reportDateLabel');

  const reportEmptyState =
    document.getElementById('reportEmptyState');

  const printReportBtn =
    document.getElementById('printReportBtn');

  let currentReportType = 'existing';
  let currentReportData = null;

    // -------------------------------
  // Report Table Scroll Controls
  // -------------------------------

  let reportTableWrapper = null;
  let reportScrollLeftBtn = null;
  let reportScrollRightBtn = null;

  function setupReportTableScrollControls() {

    reportScrollLeftBtn =
      document.getElementById('reportScrollLeft');

    reportScrollRightBtn =
      document.getElementById('reportScrollRight');

    if (
      !reportTableContainer ||
      !reportScrollLeftBtn ||
      !reportScrollRightBtn
    ) {
      return;
    }

    // Scroll table to the left
    reportScrollLeftBtn.addEventListener(
      'click',
      () => {

        reportTableContainer.scrollTo({
          left:
            reportTableContainer.scrollLeft - 400,
          behavior: 'smooth'
        });

      }
    );


    // Scroll table to the right
    reportScrollRightBtn.addEventListener(
      'click',
      () => {

        reportTableContainer.scrollTo({
          left:
            reportTableContainer.scrollLeft + 400,
          behavior: 'smooth'
        });

      }
    );


    // Update arrow state when table is manually scrolled
    reportTableContainer.addEventListener(
      'scroll',
      updateReportScrollArrows
    );


    // Recalculate arrow state if screen size changes
    window.addEventListener(
      'resize',
      updateReportScrollArrows
    );


    // Set initial arrow state
    updateReportScrollArrows();
  }


  function updateReportScrollArrows() {

    if (
      !reportTableContainer ||
      !reportScrollLeftBtn ||
      !reportScrollRightBtn
    ) {
      return;
    }


    const hasTable =
      reportTableContainer.querySelector(
        '.report-table'
      );


    // No table currently displayed
    if (!hasTable) {

      reportScrollLeftBtn.style.visibility =
        'hidden';

      reportScrollRightBtn.style.visibility =
        'hidden';

      return;
    }


    const maxScrollLeft =
      reportTableContainer.scrollWidth -
      reportTableContainer.clientWidth;

    console.log(
      'Table scroll:',
      reportTableContainer.scrollLeft,
      reportTableContainer.scrollWidth,
      reportTableContainer.clientWidth
    );


    // Table fits completely — no horizontal
    // scrolling is required
    if (maxScrollLeft <= 1) {

      reportScrollLeftBtn.style.visibility =
        'hidden';

      reportScrollRightBtn.style.visibility =
        'hidden';

      return;
    }


    // Table needs horizontal scrolling
    reportScrollLeftBtn.style.visibility =
      'visible';

    reportScrollRightBtn.style.visibility =
      'visible';


    const currentScroll =
      reportTableContainer.scrollLeft;


    // Disable left arrow at the beginning
    reportScrollLeftBtn.disabled =
      currentScroll <= 1;


    // Disable right arrow at the end
    reportScrollRightBtn.disabled =
      currentScroll >= maxScrollLeft - 1;
  }

  setupReportTableScrollControls();

  // -------------------------------
  // Report Date
  // -------------------------------

  function getTodayDate() {

    const today = new Date();

    return today.toISOString().split('T')[0];

  }


  function setReportDateToToday() {

    if (reportDateInput) {

      reportDateInput.value =
        getTodayDate();

    }

  }


  // -------------------------------
  // Active Report Toggle
  // -------------------------------

  function setActiveReportType(type) {

    currentReportType = type;

    reportToggleButtons.forEach(button => {

      const isActive =
        button.dataset.reportType === type;

      button.classList.toggle(
        'active',
        isActive
      );

      button.setAttribute(
        'aria-selected',
        isActive ? 'true' : 'false'
      );

    });

  }


  // -------------------------------
  // Calculate Principal Till Date
  // -------------------------------

  function getPrincipalTillDate(record, reportDate) {

    let principal =
      Number(record.amount) || 0;

    const transactions = [];


    (record.topUps || []).forEach(topup => {

      transactions.push({
        date: topup.date,
        type: 'TOPUP',
        amount: Number(topup.amount) || 0
      });

    });


    (record.paidUps || []).forEach(paidup => {

      transactions.push({
        date: paidup.date,
        type: 'PAIDUP',
        amount: Number(paidup.amount) || 0
      });

    });


    transactions.sort(
      (a, b) =>
        new Date(a.date) - new Date(b.date)
    );


    transactions.forEach(transaction => {

      if (
        new Date(transaction.date) <=
        new Date(reportDate)
      ) {

        if (transaction.type === 'TOPUP') {

          principal += transaction.amount;

        }
        else {

          principal -= transaction.amount;

        }

      }

    });


    return principal;

  }


  // -------------------------------
  // Calculate Interest Paid Till Date
  // -------------------------------const existingRecords =

  function getInterestPaidTillDate(
    record,
    reportDate
  ) {

    return (record.interestPayments || [])
      .filter(payment =>
        payment.interestPaidTill &&
        new Date(payment.interestPaidTill) <=
        new Date(reportDate)
      )
      .reduce(
        (total, payment) =>
          total + Number(payment.amount || 0),
        0
      );

  }


  // -------------------------------
  // Calculate Interest Accrued Till Date
  // -------------------------------

  function getInterestAccruedTillDate(
    record,
    reportDate
  ) {

    if (
      new Date(record.entryDate) >
      new Date(reportDate)
    ) {

      return 0;

    }


    /*
    * Interest is calculated from the entry date
    * up to the selected report date.
    *
    * Top-Ups increase principal.
    * Paid-Ups decrease principal.
    */

    return calculateInterestForPeriod(
      record,
      record.entryDate,
      reportDate
    );

  }


  // -------------------------------
  // Existing Customer Report
  // -------------------------------

  function buildExistingCustomerReport(
    records,
    reportDate
  ) {

    const existingRecords =
      records.filter(record => {

        // Customer must have entered on or before
        // the selected report date.
        if (
          new Date(record.entryDate) >
          new Date(reportDate)
        ) {
          return false;
        }


        // If the customer was released before or
        // on the selected date, they are not existing
        // as of that date.
        if (
          record.releaseDate &&
          record.releaseDate !== '' &&
          new Date(record.releaseDate) <=
          new Date(reportDate)
        ) {
          return false;
        }


        // Otherwise, the customer was existing
        // as of the selected report date.
        return true;

      });


    let totalPrincipal =
      0;

    let totalInterestAccrued =
      0;

    let totalInterestPaid =
      0;


    const customers =
      existingRecords.map(record => {

        const principal =
          getPrincipalTillDate(
            record,
            reportDate
          );

        const interestAccrued =
          getInterestAccruedTillDate(
            record,
            reportDate
          );

        const interestPaid =
          getInterestPaidTillDate(
            record,
            reportDate
          );

        const pendingInterest =
          Math.max(
            0,
            interestAccrued - interestPaid
          );

        const totalRecoverable =
          principal + pendingInterest;


        totalPrincipal += principal;

        totalInterestAccrued +=
          interestAccrued;

        totalInterestPaid +=
          interestPaid;


        return {

          record,

          principalEntered:
            Number(record.amount) || 0,

          currentPrincipal:
            principal,

          interestAccrued,

          interestPaid,

          pendingInterest,

          totalRecoverable

        };

      });


    const pendingInterest =
      Math.max(
        0,
        totalInterestAccrued -
        totalInterestPaid
      );


    return {

      customers,

      summary: {

        customerCount:
          customers.length,

        principal:
          totalPrincipal,

        interestAccrued:
          totalInterestAccrued,

        interestPaid:
          totalInterestPaid,

        pendingInterest,

        totalRecoverable:
          totalPrincipal +
          pendingInterest

      }

    };

  }


  // -------------------------------
  // Released Customer Report
  // -------------------------------

  function buildReleasedCustomerReport(
    records,
    reportDate
  ) {

    const releasedRecords =
      records.filter(record => {

        if (record.status !== 'RELEASED') {
          return false;
        }

        if (!record.releaseDate) {
          return false;
        }

        return (
          new Date(record.releaseDate) <=
          new Date(reportDate)
        );

      });


    let totalPrincipalReleased = 0;
    let totalInterestTillRelease = 0;
    let totalInterestPaid = 0;
    let totalRemainingInterest = 0;
    let totalRecoverable = 0;


    const customers =
      releasedRecords.map(record => {

        const principalReleased =
          getPrincipalTillDate(
            record,
            record.releaseDate
          );


        // Total interest actually accrued up to release date
        const interestTillRelease =
          getInterestAccruedTillDate(
            record,
            record.releaseDate
          );


        // Interest that was already paid before/during the loan
        const interestPaid =
          (record.interestPayments || [])
            .reduce(
              (total, payment) =>
                total +
                Number(payment.amount || 0),
              0
            );


        // Interest still payable at release
        const remainingInterest =
          Math.max(
            0,
            interestTillRelease - interestPaid
          );


        // Amount still recoverable at release
        const recoverable =
          principalReleased + remainingInterest;


        totalPrincipalReleased +=
          principalReleased;

        totalInterestTillRelease +=
          interestTillRelease;

        totalInterestPaid +=
          interestPaid;

        totalRemainingInterest +=
          remainingInterest;

        totalRecoverable +=
          recoverable;


        return {

          record,

          principalEntered:
            Number(record.amount) || 0,

          principalReleased,

          totalInterestTillRelease:
            interestTillRelease,

          interestAlreadyPaid:
            interestPaid,

          remainingInterestToPay:
            remainingInterest,

          totalRecoverable:
            recoverable

        };

      });


    return {

      customers,

      summary: {

        customerCount:
          customers.length,

        principalReleased:
          totalPrincipalReleased,

        totalInterestTillRelease:
          totalInterestTillRelease,

        interestAlreadyPaid:
          totalInterestPaid,

        remainingInterestToPay:
          totalRemainingInterest,

        totalRecoverable:
          totalRecoverable

      }

    };

  }


  // -------------------------------
  // Render Summary
  // -------------------------------

  function renderReportSummary(
    reportData
  ) {

    const summary =
      reportData.summary;


    if (currentReportType === 'existing') {

      reportSummary.innerHTML = `

        <div class="report-summary-card">

          <span>Customers</span>

          <strong>
            ${summary.customerCount}
          </strong>

        </div>


        <div class="report-summary-card">

          <span>Principal</span>

          <strong>
            ${formatCurrency(summary.principal)}
          </strong>

        </div>


        <div class="report-summary-card">

          <span>Interest Accrued</span>

          <strong>
            ${formatCurrency(summary.interestAccrued)}
          </strong>

        </div>


        <div class="report-summary-card">

          <span>Interest Paid</span>

          <strong>
            ${formatCurrency(summary.interestPaid)}
          </strong>

        </div>


        <div class="report-summary-card">

          <span>Pending Interest</span>

          <strong>
            ${formatCurrency(summary.pendingInterest)}
          </strong>

        </div>


        <div class="report-summary-card">

          <span>Total Recoverable</span>

          <strong>
            ${formatCurrency(summary.totalRecoverable)}
          </strong>

        </div>

      `;

    }
    else {

      reportSummary.innerHTML = `

        <div class="report-summary-card">

          <span>Customers</span>

          <strong>
            ${summary.customerCount}
          </strong>

        </div>


        <div class="report-summary-card">

          <span>Principal Released</span>

          <strong>
            ${formatCurrency(
              summary.principalReleased
            )}
          </strong>

        </div>


        <div class="report-summary-card">

          <span>Total Interest Till Release</span>

          <strong>
            ${formatCurrency(
              summary.totalInterestTillRelease
            )}
          </strong>

        </div>


        <div class="report-summary-card">

          <span>Interest Already Paid</span>

          <strong>
            ${formatCurrency(
              summary.interestAlreadyPaid
            )}
          </strong>

        </div>


        <div class="report-summary-card">

          <span>Remaining Interest To Pay</span>

          <strong>
            ${formatCurrency(
              summary.remainingInterestToPay
            )}
          </strong>

        </div>


        <div class="report-summary-card">

          <span>Total Recoverable</span>

          <strong>
            ${formatCurrency(
              summary.totalRecoverable
            )}
          </strong>

        </div>

      `;

    }

  }


  // -------------------------------
  // Render Existing Customer Table
  // -------------------------------

  function renderExistingCustomerTable(
    customers
  ) {

    if (customers.length === 0) {

      reportTableContainer.innerHTML = `
        <p class="empty-state">
          No existing customers found for the selected date.
        </p>
      `;

      return;

    }


    reportTableContainer.innerHTML = `

      <table class="report-table">

        <thead>

          <tr>

            <th>Sr. No.</th>

            <th>Packet No.</th>

            <th>Customer Name</th>

            <th>Phone Number</th>

            <th>Entry Date</th>

            <th>Principal Entered</th>

            <th>Current Principal</th>

            <th>ROI</th>

            <th>Interest Accrued</th>

            <th>Interest Paid</th>

            <th>Pending Interest</th>

            <th>Total Recoverable</th>

          </tr>

        </thead>


        <tbody>

          ${customers.map(
            (customer, index) => {

              const record =
                customer.record;

              return `

                <tr>

                  <td>
                    ${index + 1}
                  </td>

                  <td>
                    ${record.packetNo}
                  </td>

                  <td>
                    ${record.customerName}
                  </td>

                  <td>
                    ${record.phoneNumber}
                  </td>

                  <td>
                    ${formatDate(record.entryDate)}
                  </td>

                  <td>
                    ${formatCurrency(
                      customer.principalEntered
                    )}
                  </td>

                  <td>
                    ${formatCurrency(
                      customer.currentPrincipal
                    )}
                  </td>

                  <td>
                    ${record.rateOfInterest}%
                  </td>

                  <td>
                    ${formatCurrency(
                      customer.interestAccrued
                    )}
                  </td>

                  <td>
                    ${formatCurrency(
                      customer.interestPaid
                    )}
                  </td>

                  <td>
                    ${formatCurrency(
                      customer.pendingInterest
                    )}
                  </td>

                  <td>
                    ${formatCurrency(
                      customer.totalRecoverable
                    )}
                  </td>

                </tr>

              `;

            }
          ).join('')}

        </tbody>

      </table>

    `;

  }


  // -------------------------------
  // Render Released Customer Table
  // -------------------------------

  function renderReleasedCustomerTable(
    customers
  ) {

    if (customers.length === 0) {

      reportTableContainer.innerHTML = `
        <p class="empty-state">
          No released customers found for the selected date.
        </p>
      `;

      return;

    }


    reportTableContainer.innerHTML = `

      <table class="report-table">

        <thead>

          <tr>

            <th>Sr. No.</th>
            <th>Packet No.</th>
            <th>Customer Name</th>
            <th>Phone Number</th>
            <th>Entry Date</th>
            <th>Release Date</th>
            <th>Principal Entered</th>
            <th>Principal Released</th>
            <th>ROI</th>
            <th>Total Interest Till Release</th>
            <th>Interest Already Paid</th>
            <th>Remaining Interest To Pay</th>
            <th>Total Recoverable</th>

          </tr>

        </thead>


        <tbody>

          ${customers.map(
            (customer, index) => {

              const record =
                customer.record;

              return `

                <tr>

                  <td>
                    ${index + 1}
                  </td>

                  <td>
                    ${record.packetNo}
                  </td>

                  <td>
                    ${record.customerName}
                  </td>

                  <td>
                    ${record.phoneNumber}
                  </td>

                  <td>
                    ${formatDate(record.entryDate)}
                  </td>

                  <td>
                    ${formatDate(record.releaseDate)}
                  </td>

                  <td>
                    ${formatCurrency(
                      customer.principalEntered
                    )}
                  </td>

                  <td>
                    ${formatCurrency(
                      customer.principalReleased
                    )}
                  </td>

                  <td>
                    ${record.rateOfInterest}%
                  </td>

                  <td>
                    ${formatCurrency(
                      customer.totalInterestTillRelease
                    )}
                  </td>

                  <td>
                    ${formatCurrency(
                      customer.interestAlreadyPaid
                    )}
                  </td>

                  <td>
                    ${formatCurrency(
                      customer.remainingInterestToPay
                    )}
                  </td>

                  <td>
                    ${formatCurrency(
                      customer.totalRecoverable
                    )}
                  </td>

                </tr>

              `;

            }
          ).join('')}

        </tbody>

      </table>

    `;

  }


  // -------------------------------
  // Load Report
  // -------------------------------

  async function loadReport() {

    if (!reportDateInput) {
      return;
    }


    const reportDate =
      reportDateInput.value;

    if (!reportDate) {
      return;
    }


    try {

      reportEmptyState.hidden = true;


      const party =
        document.getElementById(
          'partySelect'
        ).value;


      const records =
        await fetchRecords({
          party
        });


      let reportData;


      if (
        currentReportType ===
        'existing'
      ) {

        reportData =
          buildExistingCustomerReport(
            records,
            reportDate
          );

        reportTableTitle.textContent =
          'Existing Customers';

      }
      else {

        reportData =
          buildReleasedCustomerReport(
            records,
            reportDate
          );

        reportTableTitle.textContent =
          'Released Customers';

      }


      currentReportData =
        reportData;


      renderReportSummary(
        reportData
      );


      if (
        currentReportType ===
        'existing'
      ) {

        renderExistingCustomerTable(
          reportData.customers
        );

      }
      else {

        renderReleasedCustomerTable(
          reportData.customers
        );

      }

      updateReportScrollArrows();

      reportDateLabel.textContent =
        `Calculated till ${formatDate(reportDate)}`;

    }
    catch (err) {

      console.error(
        'Report Error:',
        err
      );


      reportSummary.innerHTML = '';

      reportTableContainer.innerHTML = '';

      reportEmptyState.textContent =
        err.message ||
        'Unable to load report.';

      reportEmptyState.hidden =
        false;

    }

  }


  // -------------------------------
  // Toggle Events
  // -------------------------------

  reportToggleButtons.forEach(
    button => {

      button.addEventListener(
        'click',
        () => {

          const reportType =
            button.dataset.reportType;

          setActiveReportType(
            reportType
          );

          // Every toggle starts from today's date
          setReportDateToToday();

          // Automatically load report
          loadReport();

        }
      );

    }
  );


  // -------------------------------
  // Date Change
  // -------------------------------

  if (reportDateInput) {

    reportDateInput.addEventListener(
      'change',
      loadReport
    );

  }


  // -------------------------------
  // Print Report
  // -------------------------------


  function generateReportPDF() {

    if (!currentReportData) {

      alert("Please load a report before printing.");

      return;

    }

    const { jsPDF } = window.jspdf;

    const pdf = new jsPDF({
      orientation: "landscape",
      unit: "mm",
      format: "a4"
    });


    const pageWidth =
      pdf.internal.pageSize.getWidth();

    const pageHeight =
      pdf.internal.pageSize.getHeight();


    const margin = 10;


    // ==========================================
    // REPORT TITLE
    // ==========================================

    pdf.setFont("helvetica", "bold");

    pdf.setFontSize(18);

    pdf.text(
      "Manibhadra Jewellers",
      pageWidth / 2,
      margin,
      {
        align: "center"
      }
    );


    pdf.setFontSize(15);

    pdf.text(
      currentReportType === "existing"
        ? "Existing Customers Report"
        : "Released Customers Report",
      pageWidth / 2,
      margin + 8,
      {
        align: "center"
      }
    );


    pdf.setFont("helvetica", "normal");

    pdf.setFontSize(9);

    pdf.text(
      `Party: ${
        document.getElementById("partySelect").value
      }`,
      margin,
      margin + 17
    );


    pdf.text(
      `Calculated Till: ${
        formatDate(reportDateInput.value)
      }`,
      pageWidth - margin,
      margin + 17,
      {
        align: "right"
      }
    );


    // ==========================================
    // SUMMARY
    // ==========================================

    const summary =
      currentReportData.summary;


    let summaryRows;


    if (currentReportType === "existing") {

      summaryRows = [

          [
              "Customers",
              String(summary.customerCount)
          ],

          [
              "Principal",
              formatPdfCurrency(summary.principal)
          ],

          [
              "Interest Accrued",
              formatPdfCurrency(summary.interestAccrued)
          ],

          [
              "Interest Paid",
              formatPdfCurrency(summary.interestPaid)
          ],

          [
              "Pending Interest",
              formatPdfCurrency(summary.pendingInterest)
          ],

          [
              "Total Recoverable",
              formatPdfCurrency(summary.totalRecoverable)
          ]

      ];

    }
    else {
      summaryRows = [
        [
          "Customers",
          String(summary.customerCount)
        ],
        [
          "Principal Released",
          formatPdfCurrency(
            summary.principalReleased
          )
        ],
        [
          "Total Interest Till Release",
          formatPdfCurrency(
            summary.totalInterestTillRelease
          )
        ],
        [
          "Interest Already Paid",
          formatPdfCurrency(
            summary.interestAlreadyPaid
          )
        ],
        [
          "Remaining Interest To Pay",
          formatPdfCurrency(
            summary.remainingInterestToPay
          )
        ],
        [
          "Total Recoverable",
          formatPdfCurrency(
            summary.totalRecoverable
          )
        ]
      ];
    }


    pdf.setFont("helvetica", "bold");

    pdf.setFontSize(11);

    pdf.text(
      "Report Summary",
      margin,
      margin + 27
    );


    pdf.autoTable({

      startY: margin + 30,

      head: [
        ["Summary", "Value"]
      ],

      body: summaryRows,

      theme: "grid",

      styles: {

        font: "helvetica",

        fontSize: 9,

        cellPadding: 3,

        textColor: [30, 30, 30],

        lineColor: [180, 180, 180],

        lineWidth: 0.2

      },

      headStyles: {

        fillColor: [90, 70, 25],

        textColor: [255, 255, 255],

        fontStyle: "bold"

      },

      columnStyles: {

        0: {
          cellWidth: 45
        },

        1: {
          cellWidth: 45
        }

      },

      margin: {
        left: margin,
        right: margin
      }

    });


    // ==========================================
    // CUSTOMER TABLE
    // ==========================================

    let tableStartY =
      pdf.lastAutoTable.finalY + 10;


    let tableHead;

    let tableBody;


    if (currentReportType === "existing") {

      tableHead = [

        "Sr. No.",

        "Packet No.",

        "Customer Name",

        "Phone Number",

        "Entry Date",

        "Principal Entered",

        "Current Principal",

        "ROI",

        "Interest Accrued",

        "Interest Paid",

        "Pending Interest",

        "Total Recoverable"

      ];


      tableBody =
        currentReportData.customers.map(
          (customer, index) => {

            const record =
              customer.record;

            return [

              index + 1,

              record.packetNo,

              record.customerName,

              record.phoneNumber,

              formatDate(
                record.entryDate
              ),

              formatPdfCurrency(
                customer.principalEntered
              ),

              formatPdfCurrency(
                customer.currentPrincipal
              ),

              `${record.rateOfInterest}%`,

              formatPdfCurrency(
                customer.interestAccrued
              ),

              formatPdfCurrency(
                customer.interestPaid
              ),

              formatPdfCurrency(
                customer.pendingInterest
              ),

              formatPdfCurrency(
                customer.totalRecoverable
              )

            ];

          }
        );

    }
    else {
      tableHead = [
        "Sr. No.",
        "Packet No.",
        "Customer Name",
        "Phone Number",
        "Entry Date",
        "Release Date",
        "Principal Entered",
        "Principal Released",
        "ROI",
        "Total Interest Till Release",
        "Interest Already Paid",
        "Remaining Interest To Pay",
        "Total Recoverable"
      ];

      tableBody =
        currentReportData.customers.map(
          (customer, index) => {

            const record =
              customer.record;

            return [
              index + 1,

              record.packetNo,

              record.customerName,

              record.phoneNumber,

              formatDate(
                record.entryDate
              ),

              formatDate(
                record.releaseDate
              ),

              formatPdfCurrency(
                customer.principalEntered
              ),

              formatPdfCurrency(
                customer.principalReleased
              ),

              `${record.rateOfInterest}%`,

              formatPdfCurrency(
                customer.totalInterestTillRelease
              ),

              formatPdfCurrency(
                customer.interestAlreadyPaid
              ),

              formatPdfCurrency(
                customer.remainingInterestToPay
              ),

              formatPdfCurrency(
                customer.totalRecoverable
              )
            ];

          }
        );
    }


    pdf.setFont("helvetica", "bold");

    pdf.setFontSize(11);

    pdf.text(
      currentReportType === "existing"
        ? "Existing Customers"
        : "Released Customers",
      margin,
      tableStartY
    );


    pdf.autoTable({

      startY: tableStartY + 4,

      head: [tableHead],

      body: tableBody,

      theme: "grid",

      styles: {

        font: "helvetica",

        fontSize: 8.5,

        cellPadding: 2,

        overflow: "linebreak",

        valign: "middle",

        lineColor: [180, 180, 180],

        lineWidth: 0.2

      },

      headStyles: {

        fillColor: [90, 70, 25],

        textColor: [255, 255, 255],

        fontStyle: "bold",

        fontSize: 8.5

      },

      alternateRowStyles: {

        fillColor: [248, 248, 248]

      },

      margin: {

        left: margin,

        right: margin

      },

      tableWidth: "auto",

      didDrawPage: function () {

        pdf.setFont(
          "helvetica",
          "normal"
        );

        pdf.setFontSize(8);

        pdf.text(
          `Page ${
            pdf.internal.getNumberOfPages()
          }`,
          pageWidth - margin,
          pageHeight - 5,
          {
            align: "right"
          }
        );

      }

    });


    // ==========================================
    // SAVE PDF
    // ==========================================

    const reportTypeName =
      currentReportType === "existing"
        ? "Existing-Customers"
        : "Released-Customers";


    const date =
      reportDateInput.value;


    pdf.save(
      `Manibhadra-Jewellers-${reportTypeName}-${date}.pdf`
    );

  }

  if (printReportBtn) {

    printReportBtn.addEventListener(
      'click',
      generateReportPDF
    );

  }


  // -------------------------------
  // Default Report
  // -------------------------------

  setActiveReportType(
    'existing'
  );

  setReportDateToToday();

  loadReport();

  const dropdownBtn = document.getElementById('customerDropdownBtn');
  const dropdownMenu = document.getElementById('customerDropdownMenu');


  const othersDropdownBtn =
    document.getElementById('othersDropdownBtn');

  const othersDropdownMenu =
    document.getElementById('othersDropdownMenu');


  function closeAllDropdowns() {

    dropdownMenu.classList.remove('show');
    othersDropdownMenu.classList.remove('show');

    dropdownBtn.classList.remove('open');
    othersDropdownBtn.classList.remove('open');

    dropdownBtn.setAttribute('aria-expanded', 'false');
    othersDropdownBtn.setAttribute('aria-expanded', 'false');

  }

  function openTab(tabId) {

    // Hide all pages
    document.querySelectorAll('.tab-panel').forEach((panel) => {
      panel.classList.remove('active');
      panel.hidden = true;
    });

    // Remove active from normal tabs
    document.querySelectorAll('.tab-btn').forEach((btn) => {
      btn.classList.remove('active');
    });

    // Remove active from dropdown items
    document.querySelectorAll('.dropdown-item').forEach((item) => {
      item.classList.remove('active');
    });

    // Show selected page
    const panel = document.getElementById(tabId);

    if (panel) {
      panel.classList.add('active');
      panel.hidden = false;
    }

    // Customer dropdown pages

    if (
      tabId === 'add-customer' ||
      tabId === 'edit-customer' ||
      tabId === 'release-customer'
    ) {

      dropdownBtn.classList.add('active');

      document.querySelector(
        '#customerDropdownBtn .dropdown-label'
      ).textContent =
        document.querySelector(
          `#customerDropdownMenu .dropdown-item[data-tab="${tabId}"]`
        ).textContent;

      othersDropdownBtn.classList.remove('active');

      document.querySelector(
        '#othersDropdownBtn .dropdown-label'
      ).textContent = 'Transactions';

      document.querySelector(
        `#customerDropdownMenu .dropdown-item[data-tab="${tabId}"]`
      )?.classList.add('active');

    }

    // Others dropdown pages
    else if (
      tabId === 'interest-payment' ||
      tabId === 'topup' ||
      tabId === 'paidup'
    ) {

      othersDropdownBtn.classList.add('active');

      document.querySelector(
        '#othersDropdownBtn .dropdown-label'
      ).textContent =
        document.querySelector(
          `#othersDropdownMenu .dropdown-item[data-tab="${tabId}"]`
        ).textContent;

      dropdownBtn.classList.remove('active');

      document.querySelector(
        '#customerDropdownBtn .dropdown-label'
      ).textContent = 'Customer';

      document.querySelector(
        `#othersDropdownMenu .dropdown-item[data-tab="${tabId}"]`
      )?.classList.add('active');

    }

    // Normal tabs
    else {

      dropdownBtn.classList.remove('active');

      document.querySelector(
        '#customerDropdownBtn .dropdown-label'
      ).textContent = 'Customer';

      othersDropdownBtn.classList.remove('active');

      document.querySelector(
        '#othersDropdownBtn .dropdown-label'
      ).textContent = 'Transactions';

      const normalBtn = document.querySelector(
        `.tab-btn[data-tab="${tabId}"]`
      );

      if (normalBtn) {
        normalBtn.classList.add('active');
      }

    }
  }

  dropdownBtn.addEventListener('click', (e) => {

    e.stopPropagation();

    const isOpen =
      dropdownMenu.classList.contains('show');

    closeAllDropdowns();

    if (!isOpen) {

      dropdownMenu.classList.add('show');
      dropdownBtn.classList.add('open');

      dropdownBtn.setAttribute(
        'aria-expanded',
        'true'
      );

    }

  });



  othersDropdownBtn.addEventListener('click', (e) => {

    e.stopPropagation();

    const isOpen =
      othersDropdownMenu.classList.contains('show');

    closeAllDropdowns();

    if (!isOpen) {

      othersDropdownMenu.classList.add('show');
      othersDropdownBtn.classList.add('open');

      othersDropdownBtn.setAttribute(
        'aria-expanded',
        'true'
      );

    }

  });

  // Customer dropdown
  dropdownMenu.querySelectorAll('.dropdown-item').forEach((item) => {

    item.addEventListener('click', () => {

      closeAllDropdowns();

      openTab(item.dataset.tab);

    });

  });

  // Others dropdown
  othersDropdownMenu.querySelectorAll('.dropdown-item').forEach((item) => {

    item.addEventListener('click', () => {

      closeAllDropdowns();

      openTab(item.dataset.tab);

    });

  });

  document.querySelectorAll('.tab-btn').forEach((btn) => {

    btn.addEventListener('click', () => {
      openTab(btn.dataset.tab);
    });

  });

  document.addEventListener('click', () => {

    closeAllDropdowns();

  });



  const editSearchBtn = document.getElementById('editSearchBtn');
  const editClearBtn = document.getElementById('editClearBtn');
  const editForm = document.getElementById('editCustomerForm');
  const editMessage = document.getElementById('editMessage');

  editSearchBtn.addEventListener('click', async () => {

    const packetNo = Number(document.getElementById('editPacketNo').value);
    const party = document.getElementById('partySelect').value;

    if (!packetNo) {
      showMessage(editMessage, 'Enter a packet number.', 'error');
      return;
    }

    try {

      const records = await fetchRecords({
        party,
        packetNo
      });

      if (records.length === 0) {

        editForm.hidden = true;

        showMessage(
          editMessage,
          'No customer found.',
          'error'
        );

        return;
      }

      const record = records[0];

      if (record.status === 'RELEASED') {

        editForm.hidden = true;

        showMessage(
          editMessage,
          'This customer has already been released and cannot be edited.',
          'error'
        );

        return;

      }

      document.getElementById('editCustomerName').value = record.customerName;
      document.getElementById('editPhoneNumber').value = record.phoneNumber;
      document.getElementById('editItem').value = record.item;
      document.getElementById('editItemName').value = record.itemName;
      document.getElementById('editAmount').value = record.amount;
      document.getElementById('editQuantity').value = record.quantity;
      document.getElementById('editWeight').value = record.weight;
      document.getElementById('editEntryDate').value = record.entryDate;
      document.getElementById('editRateOfInterest').value = record.rateOfInterest;

      // Disable Amount & ROI if customer has transactions
      document.getElementById('editAmount').disabled = record.hasTransactions;
      document.getElementById('editRateOfInterest').disabled = record.hasTransactions;
      document.getElementById('editEntryDate').disabled = record.hasTransactions;

      editForm.hidden = false;

    }

    catch (err) {

      showMessage(
        editMessage,
        err.message,
        'error'
      );

    }

  });


  document.getElementById('editPacketNo').addEventListener('keydown', (e) => {

    if (e.key === 'Enter') {

      e.preventDefault();

      editSearchBtn.click();

    }

  });

  editClearBtn.addEventListener('click', () => {

    document.getElementById('editPacketNo').value = '';

    editForm.reset();

    document.getElementById('editAmount').disabled = false;
    document.getElementById('editRateOfInterest').disabled = false;
    document.getElementById('editEntryDate').disabled = false;

    editForm.hidden = true;

    editMessage.hidden = true;

  });

  editForm.addEventListener('submit', async (e) => {

    e.preventDefault();

    const payload = {
      party: document.getElementById('partySelect').value,
      packetNo: Number(document.getElementById('editPacketNo').value),

      customerName: document.getElementById('editCustomerName').value.trim(),
      phoneNumber: document.getElementById('editPhoneNumber').value.trim(),
      item: document.getElementById('editItem').value,
      itemName: document.getElementById('editItemName').value.trim(),
      amount: Number(document.getElementById('editAmount').value),
      quantity: Number(document.getElementById('editQuantity').value),
      weight: Number(document.getElementById('editWeight').value),
      entryDate: document.getElementById('editEntryDate').value,
      rateOfInterest: Number(document.getElementById('editRateOfInterest').value)
    };

    try {

      await apiRequest('/api/records/edit', {
        method: 'PUT',
        body: JSON.stringify(payload)
      });

      showMessage(
        editMessage,
        'Customer updated successfully.',
        'success'
      );

    }

    catch (err) {

      showMessage(
        editMessage,
        err.message,
        'error'
      );

    }

  });



  const releaseSearchBtn = document.getElementById('releaseSearchBtn');
  const releaseClearBtn = document.getElementById('releaseClearBtn');

  const releaseForm = document.getElementById('releaseCustomerForm');
  const releaseMessage = document.getElementById('releaseMessage');

  let currentReleaseRecord = null;

  releaseSearchBtn.addEventListener('click', async () => {

    const packetNo = Number(document.getElementById('releasePacketNo').value);

    const party = document.getElementById('partySelect').value;

    if (!packetNo) {

      showMessage(
        releaseMessage,
        'Enter a packet number.',
        'error'
      );

      return;

    }

    try {

      const records = await fetchRecords({
        party,
        packetNo
      });

      if (records.length === 0) {

        releaseForm.hidden = true;

        showMessage(
          releaseMessage,
          'No customer found.',
          'error'
        );

        return;

      }

      currentReleaseRecord = records[0];

      const releaseButton = releaseForm.querySelector('button[type="submit"]');

      document.getElementById('releaseCustomerName').value = currentReleaseRecord.customerName;
      document.getElementById('releasePhoneNumber').value = currentReleaseRecord.phoneNumber;
      document.getElementById('releaseItem').value = currentReleaseRecord.item;
      document.getElementById('releaseItemName').value = currentReleaseRecord.itemName;
      document.getElementById('releaseAmount').value = currentReleaseRecord.amount;

      document
        .getElementById('interestToBePaid')
        .classList.add('release-important');

      document
        .getElementById('totalRecoverable')
        .classList.add('release-important');

      document
        .getElementById('totalAmountWithInterest')
        .classList.add('release-grand');

      document.getElementById('releaseQuantity').value = currentReleaseRecord.quantity;
      document.getElementById('releaseWeight').value = currentReleaseRecord.weight;
      document.getElementById('releaseEntryDate').value = currentReleaseRecord.entryDate;
      document.getElementById('releaseROI').value = currentReleaseRecord.rateOfInterest;

      document.getElementById('releaseDate').value = '';
      if (currentReleaseRecord.status === 'RELEASED') {

        document.getElementById('releaseDate').value =
          currentReleaseRecord.releaseDate;

        document.getElementById('releaseDate').disabled = true;

        try {

          const result = await apiRequest(
            '/api/records/release-preview',
            {
              method: 'POST',
              body: JSON.stringify({

                party: document.getElementById('partySelect').value,

                packetNo: Number(
                  document.getElementById('releasePacketNo').value
                ),

                releaseDate: currentReleaseRecord.releaseDate

              })
            }
          );

          console.log(result);

          document.getElementById('totalInterestTillRelease').value =
            formatCurrency(result.totalInterest);

          document.getElementById('interestAlreadyPaid').value =
            formatCurrency(result.interestAlreadyPaid);

          document.getElementById('interestToBePaid').value =
            formatCurrency(result.remainingInterest);

          const principalAmount =
            getCurrentPrincipal(currentReleaseRecord);

          document.getElementById('totalRecoverable').value =
            formatCurrency(
              principalAmount +
              result.remainingInterest
            );

          document.getElementById('totalAmountWithInterest').value =
            formatCurrency(
              principalAmount +
              result.totalInterest
            );

        }
        catch (err) {

          console.error(err);

        }

        releaseButton.textContent = '✔ Customer Released';

        releaseButton.disabled = true;

        showMessage(
          releaseMessage,
          'Customer has already been released.',
          'success'
        );

      }
      else {

        document.getElementById('releaseDate').value = '';

        document.getElementById('releaseDate').disabled = false;


        const minimumReleaseDate = new Date(currentReleaseRecord.entryDate);

        minimumReleaseDate.setDate(
          minimumReleaseDate.getDate() + 1
        );

        document.getElementById('releaseDate').min =
          minimumReleaseDate.toISOString().split('T')[0];

        document.getElementById('totalInterestTillRelease').value = '';

        document.getElementById('interestAlreadyPaid').value = '';

        document.getElementById('interestToBePaid').value = '';

        document.getElementById('totalRecoverable').value = '';

        document.getElementById('totalAmountWithInterest').value = '';

        releaseButton.style.display = 'inline-block';

        releaseButton.disabled = false;

        releaseButton.textContent = 'Release Customer';

      }

      releaseForm.hidden = false;

    }
    catch (err) {

      showMessage(
        releaseMessage,
        err.message,
        'error'
      );

    }

  });


  releaseClearBtn.addEventListener('click', () => {

    currentReleaseRecord = null;

    document.getElementById('releasePacketNo').value = '';

    releaseForm.reset();

    document.getElementById('releaseDate').disabled = false;

    releaseForm.hidden = true;

    releaseMessage.hidden = true;

  });


  releaseForm.addEventListener('submit', async (e) => {

    e.preventDefault();

    if (!currentReleaseRecord) {

      showMessage(
        releaseMessage,
        'Search a customer first.',
        'error'
      );

      return;

    }

    const payload = {

      party: document.getElementById('partySelect').value,

      packetNo: Number(
        document.getElementById('releasePacketNo').value
      ),

      releaseDate: document.getElementById('releaseDate').value

    };

    try {

      await apiRequest('/api/records/release', {

        method: 'PUT',

        body: JSON.stringify(payload)

      });

      showMessage(
        releaseMessage,
        'Customer released successfully.',
        'success'
      );

      currentReleaseRecord.status = 'RELEASED';

      currentReleaseRecord.releaseDate =
        payload.releaseDate;

      const releaseButton =
        releaseForm.querySelector('button[type="submit"]');

      releaseButton.textContent = '✔ Customer Released';

      releaseButton.disabled = true;

    }

    catch (err) {

      showMessage(
        releaseMessage,
        err.message,
        'error'
      );

    }

  });


  document.getElementById('releaseDate').addEventListener('change', async () => {


    if (!currentReleaseRecord) return;

    const releaseDate = document.getElementById('releaseDate').value;

    if (!releaseDate) {

      document.getElementById('totalInterestTillRelease').value = '';

      document.getElementById('interestAlreadyPaid').value = '';

      document.getElementById('interestToBePaid').value = '';

      document.getElementById('totalRecoverable').value = '';

      document.getElementById('totalAmountWithInterest').value = '';

      return;

    }

    try {

      const result = await apiRequest(

        '/api/records/release-preview',

        {

          method: 'POST',

          body: JSON.stringify({

            party: document.getElementById('partySelect').value,

            packetNo: Number(document.getElementById('releasePacketNo').value),

            releaseDate

          })

        }

      );

      document.getElementById('totalInterestTillRelease').value =
        formatCurrency(result.totalInterest);

      document.getElementById('interestAlreadyPaid').value =
        formatCurrency(result.interestAlreadyPaid);

      document.getElementById('interestToBePaid').value =
        formatCurrency(result.remainingInterest);


      const principalAmount =
        getCurrentPrincipal(currentReleaseRecord);

      document.getElementById('totalRecoverable').value =
        formatCurrency(
          principalAmount +
          result.remainingInterest
        );

      document.getElementById('totalAmountWithInterest').value =
        formatCurrency(
          principalAmount +
          result.totalInterest
        );

    }

    catch (err) {

        document.getElementById('totalInterestTillRelease').value = '';

        document.getElementById('interestAlreadyPaid').value = '';

        document.getElementById('interestToBePaid').value = '';

        document.getElementById('totalRecoverable').value = '';

        document.getElementById('totalAmountWithInterest').value = '';

        showMessage(
            releaseMessage,
            err.message,
            'error'
        );

    }

  });


  const interestPaymentSearchBtn = document.getElementById('interestPaymentSearchBtn');
  const interestPaymentClearBtn = document.getElementById('interestPaymentClearBtn');

  const interestPaymentForm = document.getElementById('interestPaymentForm');
  const interestPaymentMessage = document.getElementById('interestPaymentMessage');

  let currentInterestRecord = null;
  let lastInterestPaidTillDate = null;


  interestPaymentSearchBtn.addEventListener('click', async () => {

    const packetNo = Number(
      document.getElementById('interestPaymentPacketNo').value
    );

    const party = document.getElementById('partySelect').value;

    if (!packetNo) {

      showMessage(
        interestPaymentMessage,
        'Enter a packet number.',
        'error'
      );

      return;

    }

    try {

      const data = await apiRequest(

        `/api/interest-payment/search?party=${encodeURIComponent(party)}&packetNo=${packetNo}`

      );

      currentInterestRecord = data.record;

      currentInterestRecord.currentPrincipal =
        getCurrentPrincipal(data.record);

      if (data.record.status === 'RELEASED') {

        currentInterestRecord = null;

        lastInterestPaidTillDate = null;

        interestPaymentForm.reset();

        interestPaymentForm.hidden = true;

        document.getElementById('interestHistory').innerHTML =
          '<p class="empty-state">Search a customer to view Interest Payment history.</p>';

        showMessage(
          interestPaymentMessage,
          'This customer has already been released. Interest payment cannot be added.',
          'error'
        );

        return;

      }

      document.getElementById('ipCustomerName').value =
        data.record.customerName;

      const currentPrincipal =
          getCurrentPrincipal(data.record);

      document.getElementById('ipAmount').value =
          currentPrincipal;

      document.getElementById('ipROI').value =
        data.record.rateOfInterest;

      document.getElementById('ipEntryDate').value =
        data.record.entryDate;

      lastInterestPaidTillDate = data.lastInterestPaidTill;

      document.getElementById('lastInterestPaidTill').value =
        data.lastInterestPaidTill
          ? formatDate(data.lastInterestPaidTill)
          : 'Not Paid Yet';


      let interestStartDate;

      if (data.lastInterestPaidTill) {

          const nextDate = new Date(data.lastInterestPaidTill);
          nextDate.setDate(nextDate.getDate() + 1);

          interestStartDate =
              nextDate.toISOString().split('T')[0];

      }
      else {

          interestStartDate =
              data.record.entryDate;

      }

      document.getElementById('interestStartDate').value =
        interestStartDate;

      document.getElementById('totalInterestPaid').value =
        formatCurrency(data.totalInterestPaid);

      document.getElementById('interestPaidTill').value = '';

      document.getElementById('interestAmount').value = '';

      document.getElementById('interestPeriod').value = '';


      document.getElementById('interestStartDate').min =
        data.record.entryDate;

      document.getElementById('interestPaidTill').min =
        interestStartDate;

      renderInterestHistory(data.history);

      interestPaymentForm.hidden = false;

    }

    catch (err) {

      interestPaymentForm.hidden = true;

      showMessage(
        interestPaymentMessage,
        err.message,
        'error'
      );

    }

  });


  interestPaymentClearBtn.addEventListener('click', () => {

    currentInterestRecord = null;
    lastInterestPaidTillDate = null;

    document.getElementById('interestPaymentPacketNo').value = '';

    interestPaymentForm.reset();

    document.getElementById('interestPeriod').value = '';

    interestPaymentForm.hidden = true;

    interestPaymentMessage.hidden = true;

    document.getElementById('interestHistory').innerHTML =
      '<p class="empty-state">Search a customer to view Interest Payment history.</p>';

  });

  document.getElementById('interestPaidTill').addEventListener('change', () => {

    if (!currentInterestRecord) return;

    const paidTill = document.getElementById('interestPaidTill').value;

    if (!paidTill) {

      document.getElementById('interestAmount').value = '';

      return;

    }

    const startDate =
      document.getElementById('interestStartDate').value;


    document.getElementById('interestPeriod').value =
      `${formatDate(startDate)} → ${formatDate(paidTill)}`;

    const interest = calculateInterestForPeriod(
        currentInterestRecord,
        startDate,
        paidTill
    );

    document.getElementById('interestAmount').value =
      formatCurrency(interest);

  });


  topupForm.addEventListener('submit', async (e) => {

      e.preventDefault();

      if (!currentTopupRecord) {

          showMessage(
              topupMessage,
              'Search customer first.',
              'error'
          );

          return;

      }

      const payload = {

          party: document.getElementById('partySelect').value,

          packetNo: Number(
              document.getElementById('topupPacketNo').value
          ),

          amount: Number(
              document.getElementById('topupAmount').value
          ),

          date: document.getElementById('topupDate').value

      };

      try {

          const result = await apiRequest(
              '/api/records/topup',
              {
                  method: 'POST',
                  body: JSON.stringify(payload)
              }
          );

          currentTopupRecord = result.record;

          renderTopupHistory(currentTopupRecord);

          showMessage(
              topupMessage,
              'Top-Up saved successfully.',
              'success'
          );

      }

      catch (err) {

          showMessage(
              topupMessage,
              err.message,
              'error'
          );

      }

  });


  paidupForm.addEventListener('submit', async (e) => {

      e.preventDefault();

      if (!currentPaidupRecord) {

          showMessage(
              paidupMessage,
              'Search customer first.',
              'error'
          );

          return;

      }

      const payload = {

          party: document.getElementById('partySelect').value,

          packetNo: Number(
              document.getElementById('paidupPacketNo').value
          ),

          amount: Number(
              document.getElementById('paidupAmount').value
          ),

          date: document.getElementById('paidupDate').value

      };

      try {

          const result = await apiRequest(
              '/api/records/paidup',
              {
                  method: 'POST',
                  body: JSON.stringify(payload)
              }
          );

          currentPaidupRecord = result.record;

          const currentPrincipal =
              getCurrentPrincipal(currentPaidupRecord);

          document.getElementById('principalBeforePaidup').value =
              currentPrincipal;

          document.getElementById('principalAfterPaidup').value =
              currentPrincipal;

          renderPaidupHistory(currentPaidupRecord);

          showMessage(
              paidupMessage,
              'Paid-Up saved successfully.',
              'success'
          );

      }

      catch (err) {

          showMessage(
              paidupMessage,
              err.message,
              'error'
          );

      }

  });


  interestPaymentForm.addEventListener('submit', async (e) => {

    e.preventDefault();

    if (!currentInterestRecord) return;

    const payload = {

      recordId: currentInterestRecord.id,

      interestStartDate:
        document.getElementById('interestStartDate').value,

      interestPaidTill:
        document.getElementById('interestPaidTill').value

    };

    try {

      await apiRequest(

        '/api/interest-payment',

        {

          method: 'POST',

          body: JSON.stringify(payload)

        }

      );

      showMessage(

        interestPaymentMessage,

        'Interest payment saved successfully.',

        'success'

      );

      interestPaymentSearchBtn.click();

    }

    catch (err) {

      showMessage(

        interestPaymentMessage,

        err.message,

        'error'

      );

    }

  });


  const partySelect = document.getElementById('partySelect');
  const shopTabs = document.getElementById('shopTabs');
  const shopContent = document.getElementById('shopContent');
  const partyEmptyState = document.getElementById('partyEmptyState');

  function updatePartyView() {
    const isShop = partySelect.value === 'Shop';
    shopTabs.hidden = !isShop;
    shopContent.hidden = !isShop;
    partyEmptyState.hidden = isShop;
  }

  partySelect.addEventListener('change', updatePartyView);
  updatePartyView();

  openTab('add-customer');
  document.getElementById('logoutBtn').addEventListener('click', logout);
}

async function initApp() {
  const authed = await requireAuth();
  if (!authed) return;

  document.getElementById('userDisplay').textContent = currentUser.username;
  setupEventListeners();
}

initApp();
