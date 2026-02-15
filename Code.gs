// ============================================================
// Google Apps Script — Budget Tracker Backend
// ============================================================
// INSTRUCTIONS:
// 1. Create a new Google Sheet
// 2. Go to Extensions > Apps Script
// 3. Paste this entire file into Code.gs (replace any existing code)
// 4. Update the SHEET_ID below with your Google Sheet ID
//    (The ID is the long string in the Sheet URL between /d/ and /edit)
// 5. Click Deploy > New Deployment
// 6. Select Type: "Web app"
// 7. Set "Execute as": Me
// 8. Set "Who has access": Anyone
// 9. Click Deploy and authorize when prompted
// 10. Copy the Web App URL and paste it into index.html as APPS_SCRIPT_URL
// ============================================================

// REPLACE THIS with your Google Sheet ID
const SHEET_ID = 'YOUR_GOOGLE_SHEET_ID_HERE';

// ============================================================
// SETUP — Run this function ONCE to create the sheet tabs
// ============================================================
function setupSheet() {
  const ss = SpreadsheetApp.openById(SHEET_ID);

  // Create Expenses tab
  let expenses = ss.getSheetByName('Expenses');
  if (!expenses) {
    expenses = ss.insertSheet('Expenses');
  }
  expenses.getRange(1, 1, 1, 9).setValues([[
    'id', 'date', 'amount', 'description', 'category', 'paidBy', 'autoCategory', 'wasCorrected', 'timestamp'
  ]]);

  // Create Budgets tab
  let budgets = ss.getSheetByName('Budgets');
  if (!budgets) {
    budgets = ss.insertSheet('Budgets');
  }
  budgets.getRange(1, 1, 1, 5).setValues([[
    'month', 'category', 'totalBudget', 'amirBudget', 'jadyBudget'
  ]]);

  // Add default budgets for current month
  const now = new Date();
  const month = Utilities.formatDate(now, Session.getScriptTimeZone(), 'yyyy-MM');
  budgets.getRange(2, 1, 4, 5).setValues([
    [month, 'Rent', 3200, 1600, 1600],
    [month, 'Grocery', 600, 500, 100],
    [month, 'Eating Out & Activities', 400, 200, 200],
    [month, 'Bills & Utilities', 400, 200, 200]
  ]);

  // Create Keywords tab
  let keywords = ss.getSheetByName('Keywords');
  if (!keywords) {
    keywords = ss.insertSheet('Keywords');
  }
  keywords.getRange(1, 1, 1, 3).setValues([['keyword', 'category', 'source']]);

  const defaultKeywords = [
    ['rent', 'Rent', 'default'], ['mortgage', 'Rent', 'default'], ['lease', 'Rent', 'default'],
    ['grocery', 'Grocery', 'default'], ['groceries', 'Grocery', 'default'],
    ['safeway', 'Grocery', 'default'], ['trader joe', 'Grocery', 'default'],
    ['whole foods', 'Grocery', 'default'], ['costco', 'Grocery', 'default'],
    ['walmart', 'Grocery', 'default'], ['target', 'Grocery', 'default'],
    ['sprouts', 'Grocery', 'default'], ['kroger', 'Grocery', 'default'],
    ['aldi', 'Grocery', 'default'], ['food', 'Grocery', 'default'],
    ['uber eats', 'Eating Out & Activities', 'default'],
    ['doordash', 'Eating Out & Activities', 'default'],
    ['grubhub', 'Eating Out & Activities', 'default'],
    ['restaurant', 'Eating Out & Activities', 'default'],
    ['cafe', 'Eating Out & Activities', 'default'],
    ['coffee', 'Eating Out & Activities', 'default'],
    ['starbucks', 'Eating Out & Activities', 'default'],
    ['dinner', 'Eating Out & Activities', 'default'],
    ['lunch', 'Eating Out & Activities', 'default'],
    ['brunch', 'Eating Out & Activities', 'default'],
    ['pizza', 'Eating Out & Activities', 'default'],
    ['sushi', 'Eating Out & Activities', 'default'],
    ['movie', 'Eating Out & Activities', 'default'],
    ['concert', 'Eating Out & Activities', 'default'],
    ['pg&e', 'Bills & Utilities', 'default'], ['pge', 'Bills & Utilities', 'default'],
    ['electric', 'Bills & Utilities', 'default'], ['water bill', 'Bills & Utilities', 'default'],
    ['internet', 'Bills & Utilities', 'default'], ['comcast', 'Bills & Utilities', 'default'],
    ['xfinity', 'Bills & Utilities', 'default'], ['phone bill', 'Bills & Utilities', 'default'],
    ['t-mobile', 'Bills & Utilities', 'default'], ['verizon', 'Bills & Utilities', 'default'],
    ['insurance', 'Bills & Utilities', 'default'], ['utility', 'Bills & Utilities', 'default'],
    ['utilities', 'Bills & Utilities', 'default'], ['gas bill', 'Bills & Utilities', 'default'],
    ['netflix', 'Bills & Utilities', 'default'], ['spotify', 'Bills & Utilities', 'default'],
    ['subscription', 'Bills & Utilities', 'default'], ['at&t', 'Bills & Utilities', 'default']
  ];
  keywords.getRange(2, 1, defaultKeywords.length, 3).setValues(defaultKeywords);

  // Delete the default Sheet1 if it exists and is empty
  const sheet1 = ss.getSheetByName('Sheet1');
  if (sheet1 && ss.getSheets().length > 1) {
    try { ss.deleteSheet(sheet1); } catch(e) {}
  }

  Logger.log('Setup complete! Tabs created: Expenses, Budgets, Keywords');
}

// ============================================================
// HTTP HANDLER — All requests go through doGet
// ============================================================
function doGet(e) {
  const params = e.parameter;
  const action = params.action;

  try {
    switch (action) {
      case 'getAllData':
        return jsonResponse(getAllData(params.month));
      case 'addExpense':
        return jsonResponse(addExpense(params));
      case 'deleteExpense':
        return jsonResponse(deleteExpense(params.id));
      case 'updateBudget':
        return jsonResponse(updateBudget(params));
      case 'addKeyword':
        return jsonResponse(addKeyword(params.keyword, params.category));
      case 'initMonth':
        return jsonResponse(initMonth(params.month));
      default:
        return jsonResponse({ error: 'Unknown action: ' + action });
    }
  } catch (err) {
    return jsonResponse({ error: err.message });
  }
}

// ============================================================
// JSON Response helper
// ============================================================
function jsonResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

// ============================================================
// GET ALL DATA for a month
// ============================================================
function getAllData(month) {
  const ss = SpreadsheetApp.openById(SHEET_ID);

  // Get ALL expenses (not just this month, so client can cache/navigate)
  const expSheet = ss.getSheetByName('Expenses');
  const expenses = [];
  if (expSheet.getLastRow() > 1) {
    const data = expSheet.getRange(2, 1, expSheet.getLastRow() - 1, 9).getValues();
    data.forEach(row => {
      if (row[0]) {
        expenses.push({
          id: String(row[0]),
          date: formatDateValue(row[1]),
          amount: Number(row[2]),
          description: String(row[3]),
          category: String(row[4]),
          paidBy: String(row[5]),
          autoCategory: String(row[6]),
          wasCorrected: Boolean(row[7]),
          timestamp: String(row[8])
        });
      }
    });
  }

  // Get ALL budgets
  const budSheet = ss.getSheetByName('Budgets');
  const budgets = [];
  if (budSheet.getLastRow() > 1) {
    const data = budSheet.getRange(2, 1, budSheet.getLastRow() - 1, 5).getValues();
    data.forEach(row => {
      if (row[0]) {
        budgets.push({
          month: String(row[0]),
          category: String(row[1]),
          totalBudget: Number(row[2]),
          amirBudget: Number(row[3]),
          jadyBudget: Number(row[4])
        });
      }
    });
  }

  // Get keywords
  const kwSheet = ss.getSheetByName('Keywords');
  const keywords = [];
  if (kwSheet.getLastRow() > 1) {
    const data = kwSheet.getRange(2, 1, kwSheet.getLastRow() - 1, 3).getValues();
    data.forEach(row => {
      if (row[0]) {
        keywords.push({
          keyword: String(row[0]),
          category: String(row[1]),
          source: String(row[2])
        });
      }
    });
  }

  return { expenses, budgets, keywords };
}

// ============================================================
// ADD EXPENSE
// ============================================================
function addExpense(params) {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const sheet = ss.getSheetByName('Expenses');

  // Check for duplicate ID
  if (sheet.getLastRow() > 1) {
    const ids = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues().flat();
    if (ids.includes(params.id)) {
      return { success: false, error: 'Duplicate expense ID' };
    }
  }

  sheet.appendRow([
    params.id,
    params.date,
    Number(params.amount),
    params.description,
    params.category,
    params.paidBy,
    params.autoCategory || '',
    params.wasCorrected === 'true',
    new Date().toISOString()
  ]);

  return { success: true };
}

// ============================================================
// DELETE EXPENSE
// ============================================================
function deleteExpense(id) {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const sheet = ss.getSheetByName('Expenses');

  if (sheet.getLastRow() <= 1) return { success: false, error: 'No expenses found' };

  const ids = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues().flat();
  const rowIndex = ids.indexOf(id);

  if (rowIndex === -1) return { success: false, error: 'Expense not found' };

  sheet.deleteRow(rowIndex + 2); // +2 for header and 0-index
  return { success: true };
}

// ============================================================
// UPDATE BUDGET
// ============================================================
function updateBudget(params) {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const sheet = ss.getSheetByName('Budgets');

  if (sheet.getLastRow() <= 1) {
    // No budgets yet, insert new row
    sheet.appendRow([params.month, params.category, Number(params.totalBudget), Number(params.amirBudget), Number(params.jadyBudget)]);
    return { success: true };
  }

  const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getValues();
  for (let i = 0; i < data.length; i++) {
    if (String(data[i][0]) === params.month && String(data[i][1]) === params.category) {
      sheet.getRange(i + 2, 3, 1, 3).setValues([[Number(params.totalBudget), Number(params.amirBudget), Number(params.jadyBudget)]]);
      return { success: true };
    }
  }

  // Not found — insert new row
  sheet.appendRow([params.month, params.category, Number(params.totalBudget), Number(params.amirBudget), Number(params.jadyBudget)]);
  return { success: true };
}

// ============================================================
// ADD KEYWORD
// ============================================================
function addKeyword(keyword, category) {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const sheet = ss.getSheetByName('Keywords');

  // Check for duplicate
  if (sheet.getLastRow() > 1) {
    const existingKw = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues().flat();
    if (existingKw.includes(keyword)) {
      return { success: false, error: 'Keyword already exists' };
    }
  }

  sheet.appendRow([keyword, category, 'learned']);
  return { success: true };
}

// ============================================================
// INIT MONTH — Create budget rows for a new month
// ============================================================
function initMonth(month) {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const sheet = ss.getSheetByName('Budgets');

  // Check if month already has entries
  if (sheet.getLastRow() > 1) {
    const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, 5).getValues();
    const existing = data.filter(r => String(r[0]) === month);
    if (existing.length > 0) return { success: true, message: 'Month already initialized' };

    // Find most recent month
    const months = [...new Set(data.map(r => String(r[0])))].sort().reverse();
    if (months.length > 0) {
      const prevMonth = months[0];
      const prevData = data.filter(r => String(r[0]) === prevMonth);
      prevData.forEach(row => {
        sheet.appendRow([month, row[1], row[2], row[3], row[4]]);
      });
      return { success: true };
    }
  }

  // No previous month — use defaults
  const defaults = [
    [month, 'Rent', 3200, 1600, 1600],
    [month, 'Grocery', 600, 500, 100],
    [month, 'Eating Out & Activities', 400, 200, 200],
    [month, 'Bills & Utilities', 400, 200, 200]
  ];
  defaults.forEach(row => sheet.appendRow(row));
  return { success: true };
}

// ============================================================
// HELPER: Format date values from Sheets
// ============================================================
function formatDateValue(val) {
  if (val instanceof Date) {
    return Utilities.formatDate(val, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  return String(val);
}
