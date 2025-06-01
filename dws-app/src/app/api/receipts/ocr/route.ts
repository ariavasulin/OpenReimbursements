import { NextResponse, type NextRequest } from 'next/server';
import { createSupabaseServerClient } from '@/lib/supabaseServerClient';
import { ImageAnnotatorClient } from '@google-cloud/vision';
import { parse, format, getYear, setYear, isValid, isFuture, compareDesc } from 'date-fns';

let visionClient: ImageAnnotatorClient;
let visionClientError: Error | null = null;

try {
  const credentialsJsonString = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  if (!credentialsJsonString) {
    throw new Error('GOOGLE_APPLICATION_CREDENTIALS_JSON environment variable is not set or empty.');
  }
  const credentials = JSON.parse(credentialsJsonString);
  visionClient = new ImageAnnotatorClient({ credentials });
  console.log('OCR API: Google Vision Client initialized with explicit credentials.');
} catch (e: any) {
  visionClientError = e;
  console.error('OCR API: FATAL - Failed to initialize Google Vision Client:', e.message);
}

const newDateRegex = /(\d{4}-\d{2}-\d{2})|(\d{1,2}\/\d{1,2}\/\d{2,4})|(\d{1,2}-\d{1,2}-\d{2,4})|(\d{1,2}\.\d{1,2}\.\d{2,4})|((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s\d{1,2}(?:st|nd|rd|th)?(?:,)?\s\d{2,4})|(\d{1,2}(?:st|nd|rd|th)?\s(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?(?:,)?\s\d{2,4})|(\d{1,2}-(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?-\d{2,4})/gi;
const dateFormats: string[] = [
  'yyyy-MM-dd',
  'MM/dd/yyyy', 'MM-dd-yyyy', 'MM.dd.yyyy',
  'MM/dd/yy', 'MM-dd-yy', 'MM.dd.yy',
  'MMM d, yyyy', 'd MMM yyyy',
  'MMMM d, yyyy', 'd MMMM yyyy',
  'dd-MMM-yyyy', 'dd-MMMM-yyyy', // Added for "19-Oct-2020" and "19-October-2020"
  'MMM do, yyyy', 'do MMM yyyy', // For "Jan 1st, 2023"
];

function parseAndSelectBestDate(fullText: string): string | null {
  const potentialDates: Date[] = [];
  const matches = fullText.matchAll(newDateRegex);

  for (const match of matches) {
    const dateString = match[0]; 
    if (!dateString) continue;

    for (const fmt of dateFormats) {
      try {
        let parsedDate = parse(dateString, fmt, new Date());
        console.log(`OCR DEBUG: Parsing '${dateString}' with format '${fmt}'. Initial parsed: ${parsedDate.toISOString()}, isValid: ${isValid(parsedDate)}`);

        if (isValid(parsedDate)) {
          let yearCorrected = false;
          const year = getYear(parsedDate);
          console.log(`OCR DEBUG: Format '${fmt}'. Initial year for '${dateString}': ${year}`);

          // If the parsed year is less than 2000, it's likely from a 2-digit year input
          // or a misinterpretation by date-fns when matching a 'yyyy' format to a 'yy' input.
          if (year < 2000) {
            const originalDateBeforeCorrection = parsedDate.toISOString();
            // Correct it to the 21st century. (e.g., 18 % 100 = 18; 18 + 2000 = 2018)
            // (e.g., 1918 % 100 = 18; 18 + 2000 = 2018)
            parsedDate = setYear(parsedDate, (year % 100) + 2000);
            yearCorrected = true;
            console.log(`OCR DEBUG: Corrected year for '${dateString}' (format '${fmt}'). Original: ${originalDateBeforeCorrection}, Corrected: ${parsedDate.toISOString()}`);
          }

          if (!isFuture(parsedDate)) {
            potentialDates.push(parsedDate);
            console.log(`OCR DEBUG: Pushed to potentialDates: ${parsedDate.toISOString()} (year corrected: ${yearCorrected}) for format '${fmt}' from dateString '${dateString}'`);
            break;
          } else {
            console.log(`OCR DEBUG: Date ${parsedDate.toISOString()} (from dateString '${dateString}', format '${fmt}') is in the future. Skipping.`);
          }
        }
      } catch (e) {
        // Ignore parsing errors
      }
    }
  }

  if (potentialDates.length === 0) {
    console.log("OCR API: No valid, non-future dates found after parsing attempts.");
    return null;
  }

  potentialDates.sort(compareDesc);
  const bestDate = potentialDates[0];
  const formattedBestDate = format(bestDate, 'yyyy-MM-dd');
  console.log("OCR API: Selected best date:", formattedBestDate, "(from raw:", bestDate, ")");
  return formattedBestDate;
}

function extractBestAmount(fullText: string): number | null {
  const lines = fullText.split('\n');
  const potentialTotalAmounts: number[] = [];

  const primaryTotalKeywords = ['TOTAL', 'GRAND TOTAL', 'TOTAL DUE', 'AMOUNT DUE', 'BALANCE DUE', 'PAYMENT DUE', '총계', '합계'];
  const primaryTotalRegex = new RegExp(
    `^(?:${primaryTotalKeywords.join('|')})\\s*[:\\s]*(?:[\\$€£¥]?\\s*)?(\\d+(?:[.,]\\d{1,2}))(?:\\s|$)`, 
    'im'
  );

  for (const line of lines) {
    const match = line.trim().match(primaryTotalRegex);
    if (match && match[1]) {
      const amountStr = match[1].replace(',', '.');
      const amount = parseFloat(amountStr);
      if (!isNaN(amount)) {
        console.log(`OCR API (Priority 1): Found total candidate ${amount} on line: "${line.trim()}"`);
        potentialTotalAmounts.push(amount);
      }
    }
  }

  if (potentialTotalAmounts.length > 0) {
    const highestPriorityTotal = Math.max(...potentialTotalAmounts);
    console.log("OCR API: Selected highest priority total:", highestPriorityTotal);
    return highestPriorityTotal;
  }

  console.log("OCR API (Priority 1): No specific line-starting total found. Proceeding to broader search.");

  const allAmountsFound: { value: number, line: string, hasGenuineTotalKeyword: boolean, isSubtotalOrTaxOrTip: boolean }[] = [];
  const amountValueRegex = /(\d+(?:[.,]\d{1,2}))/g;

  for (const line of lines) {
    const trimmedLine = line.trim().toUpperCase();
    const numbersInLine = Array.from(trimmedLine.matchAll(amountValueRegex), m => m[1]);

    if (numbersInLine.length > 0) {
        const lineIsGenuineTotal = /\bTOTAL\b/.test(trimmedLine) && !(/\bSUBTOTAL\b|\bSUB TOTAL\b|\bTAX\b|\bTIP\b|\bSVC\b|\bSERVICE CHARGE\b|\bDISCOUNT\b|\bCHANGE\b|\bCASH\b/.test(trimmedLine));
        const lineIsSubtotalOrTaxOrTip = /\bSUBTOTAL\b|\bSUB TOTAL\b|\bTAX\b|\bTIP\b|\bSVC\b|\bSERVICE CHARGE\b/.test(trimmedLine);
        
        for (const numStr of numbersInLine) {
            const amountStr = numStr.replace(',', '.');
            const amount = parseFloat(amountStr);
            if (!isNaN(amount)) {
                allAmountsFound.push({ 
                    value: amount, 
                    line: trimmedLine, 
                    hasGenuineTotalKeyword: lineIsGenuineTotal, 
                    isSubtotalOrTaxOrTip: lineIsSubtotalOrTaxOrTip 
                });
            }
        }
    }
  }
  
  if (allAmountsFound.length === 0) {
    console.log("OCR API (Broader Search): No amounts found.");
    return null;
  }

  const amountsOnGenuineTotalLines = allAmountsFound.filter(a => a.hasGenuineTotalKeyword);
  if (amountsOnGenuineTotalLines.length > 0) {
    const maxTotalAmount = Math.max(...amountsOnGenuineTotalLines.map(a => a.value));
    console.log("OCR API (Priority 2): Selected max amount from 'genuine TOTAL' keyword lines:", maxTotalAmount);
    return maxTotalAmount;
  }
  
  console.log("OCR API (Priority 2): No 'genuine TOTAL' lines with amounts found.");

  const nonSubtotalTaxTipAmounts = allAmountsFound.filter(a => !a.isSubtotalOrTaxOrTip);
  if (nonSubtotalTaxTipAmounts.length > 0) {
      const maxNonSpecialAmount = Math.max(...nonSubtotalTaxTipAmounts.map(a => a.value));
      console.log("OCR API (Fallback 1): Selected max non-subtotal/tax/tip amount:", maxNonSpecialAmount);
      return maxNonSpecialAmount;
  }

  const overallMaxAmount = Math.max(...allAmountsFound.map(a => a.value));
  console.log("OCR API (Fallback 2 - Risky): Selected overall max amount:", overallMaxAmount);
  return overallMaxAmount;
}


export async function POST(request: NextRequest) {
  if (visionClientError || !visionClient) {
    console.error('OCR API: Vision client not initialized. Cannot process request.', visionClientError);
    return NextResponse.json({ error: 'OCR service initialization failed.', details: visionClientError?.message }, { status: 500 });
  }

  try {
    const supabase = await createSupabaseServerClient();
    const { data: { session }, error: sessionError } = await supabase.auth.getSession();

    if (sessionError || !session) {
      console.error('OCR API: Unauthorized - Session error or no session', sessionError);
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const { tempFilePath } = body;

    if (!tempFilePath || typeof tempFilePath !== 'string') {
      return NextResponse.json({ error: 'Missing or invalid tempFilePath' }, { status: 400 });
    }

    const { data: fileData, error: downloadError } = await supabase.storage
      .from('receipt-images') 
      .download(tempFilePath);

    if (downloadError || !fileData) {
      console.error(`OCR API: Error downloading file from Supabase Storage: ${tempFilePath}`, downloadError);
      return NextResponse.json({ error: 'Failed to download image from storage', details: downloadError?.message }, { status: 500 });
    }

    const imageBytes = Buffer.from(await fileData.arrayBuffer());
    const [result] = await visionClient.textDetection(imageBytes);
    const detections = result.textAnnotations;

    let extractedDate: string | null = null;
    let extractedAmount: number | null = null;

    if (detections && detections.length > 0) {
      const fullText = detections[0].description || "";
      console.log("OCR API: Full detected text:\n", fullText);

      extractedDate = parseAndSelectBestDate(fullText);
      extractedAmount = extractBestAmount(fullText);
      
    } else {
      console.log("OCR API: No text detections found in the image.");
    }

    console.log("OCR API: Returning data to client:", { date: extractedDate, amount: extractedAmount });
    return NextResponse.json({
      success: true,
      data: {
        date: extractedDate,
        amount: extractedAmount,
      },
    });

  } catch (error: any) {
    console.error('OCR API: Unexpected error:', error);
    return NextResponse.json({ error: 'Internal server error', details: error.message }, { status: 500 });
  }
}