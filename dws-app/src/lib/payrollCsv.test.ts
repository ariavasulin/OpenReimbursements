import { describe, expect, it } from "vitest";
import { buildPayrollCsv, quoteCsv } from "./payrollCsv";

describe("quoteCsv", () => {
  // The pre-refactor implementation quotes EVERY value, plain or not.
  it("quotes plain values", () => {
    expect(quoteCsv("Smith")).toBe('"Smith"');
  });
  it("quotes and doubles embedded quotes", () => {
    expect(quoteCsv('He said "hi"')).toBe('"He said ""hi"""');
  });
  it("quotes values containing a comma", () => {
    expect(quoteCsv("Smith, Jr")).toBe('"Smith, Jr"');
  });
});

describe("buildPayrollCsv", () => {
  it("reproduces the pre-refactor output for a known set of rows", () => {
    // Golden fixture: this exact expected string was produced by running the
    // pre-refactor inline implementation (receipt-dashboard.tsx quoteCsv +
    // downloadPayrollCSV, copied verbatim into a standalone script) over these
    // rows, before the refactor. It covers: "Last, First" names, a no-comma
    // name, multiple receipts summing per employee, empty employeeId rows
    // collapsing into one keyed-on-'' bucket (first name wins, amounts sum),
    // quotes in names, a string amount, a NaN amount (-> 0.00), an empty
    // name, and last/first sorting.
    const rows = [
      { employeeId: "1001", employeeName: "Smith, John", amount: 12.5 },
      { employeeId: "1002", employeeName: "Cher", amount: 100 },
      { employeeId: "1001", employeeName: "Smith, John", amount: 7.25 },
      { employeeId: "", employeeName: "Doe, Jane", amount: 3.333 },
      { employeeId: "1003", employeeName: 'O\'Brien, Conan "Coco"', amount: "19.99" },
      { employeeId: "", employeeName: "Roe, Rachel", amount: 1.5 },
      { employeeId: "1004", employeeName: "Adams, Amy", amount: NaN },
      { employeeId: "1005", employeeName: "", amount: 4 },
    ];

    const expected =
      'LastName,FirstName,EmployeeNumber,TotalAmount\n' +
      '"","","1005",4.00\n' +
      '"","Cher","1002",100.00\n' +
      '"Adams","Amy","1004",0.00\n' +
      '"Doe","Jane","",4.83\n' +
      '"O\'Brien","Conan ""Coco""","1003",19.99\n' +
      '"Smith","John","1001",19.75';

    expect(buildPayrollCsv(rows)).toBe(expected);
  });

  it("returns only the header line for no rows", () => {
    expect(buildPayrollCsv([])).toBe("LastName,FirstName,EmployeeNumber,TotalAmount");
  });
});
