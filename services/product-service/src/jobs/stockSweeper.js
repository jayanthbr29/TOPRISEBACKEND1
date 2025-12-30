// jobs/stockSweeper.js
const cron = require("node-cron"); //  npm i node-cron
const mongoose = require("mongoose");
const Product = require("../models/productModel"); // ↳ your schema
const ProductLog = require("../models/productLogs"); // ↳ from earlier
const logger = require("/packages/utils/logger");
const  axios = require('axios');
const MONGO_URI =
  "mongodb+srv://techdev:dLLlFqu0Wx103dzp@toprisedev.xoptvj9.mongodb.net/?retryWrites=true&w=majority&appName=toprisedev";
const DEFAULT_EXPIRY_MIN = 60 * 24; // 24 h if stock_expiry_rule not set
 
/* ───────────────────────────── helpers ──────────────────────────── */
const minsAgo = (m) => Date.now() - m * 60_000;

/**
 * Decide if a given product should be out-of-stock.
 * @param {Document} p – mongoose Product doc (lean or full)
 * @param {Number}   nowMs – Date.now() already computed for speed
 */
// function computeOOS(p, nowMs) {
//   // rule #1 – no dealers array or empty
//   if (!Array.isArray(p.available_dealers) || p.available_dealers.length === 0) {
//     return true;
//   }

//   // rule #2 – every dealer fails qty > 0 *or* is stale
//   const expiryMin = p.stock_expiry_rule || DEFAULT_EXPIRY_MIN;
//   const cutoffMs = nowMs - expiryMin * 60_000;

//   const anyFreshInStock = p.available_dealers.some((d) => {
//     const qty = d.quantity_per_dealer ?? 0;
//     const ts = new Date(d.last_stock_update || 0).getTime();
//     return qty > 0 && ts >= cutoffMs;
//   });

//   return !anyFreshInStock;
// }

 async function  cleanAndComputeOOS(p, nowMs,days=60) {
//call user service to get last stock update fro user service
 
  const SEVEN_DAYS_MS = days * 24 * 60 * 60 * 1000;
  // const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
  const sevenDayCutoff = nowMs - SEVEN_DAYS_MS;

  // First: remove dealers with stale stock > 7 days
  const freshDealers = (p.available_dealers || []).filter((d) => {
    const lastUpdate = new Date(d.last_stock_updated || 0).getTime();
    return lastUpdate >= sevenDayCutoff;
  });

  const removedCount = (p.available_dealers || []).length - freshDealers.length;

  // Overwrite the array with fresh dealers
  p.available_dealers = freshDealers;

  // If no dealers remain → product is out of stock
  if (freshDealers.length === 0) {
    return { outOfStock: true, removedCount };
  }

  // Compute stock expiry rule-based OOS
  const expiryMin = p.stock_expiry_rule || DEFAULT_EXPIRY_MIN;
  const expiryCutoff = nowMs - expiryMin * 60_000;

  const anyFreshInStock = freshDealers.some((d) => {
    const qty = d.quantity_per_dealer ?? 0;
    const ts = new Date(d.last_stock_updated || 0).getTime();
    return qty > 0 && ts >= expiryCutoff;
  });

  return { outOfStock: !anyFreshInStock, removedCount };
}

/* ───────────────────────── scheduled task ───────────────────────── */
async function sweep() {
 

  const started = Date.now();
  logger.info("🔄 Stock-sweeper tick…");
  const appSettingResp = await axios.get(
    "http://user-service:5001/api/appSetting"
  );
  const days = appSettingResp.data?.data?.lastStockCheck || 60;
  
  const cursor = Product.find(
    {},
    {
      // lean cursor for low RAM
      _id: 1,
      out_of_stock: 1,
      available_dealers: 1,
      // stock_expiry_rule: 1,
    }
  )
    .lean()
    .cursor();

    // console.log("cursor", cursor)

  let checked = 0,
    updated = 0,
    logs = [];

  // for await (const prod of cursor) {
  //   checked++;
  //   const shouldBeOOS = computeOOS(prod, started);



  //   if (shouldBeOOS !== prod.out_of_stock) {
  //     // • update only if changed
  //     await Product.updateOne(
  //       { _id: prod._id },
  //       {
  //         $set: { out_of_stock: shouldBeOOS, updated_at: new Date() },
  //         $inc: { iteration_number: 1 },
  //       }
  //     );

  //     updated++;
  //     logs.push({
  //       job_type: "Stock-Sweep",
  //       product_ref: prod._id,
  //       user: "SYSTEM",
  //       changed_fields: ["out_of_stock"],
  //       changed_value: [
  //         {
  //           field: "out_of_stock",
  //           old_value: prod.out_of_stock,
  //           new_value: shouldBeOOS,
  //         },
  //       ],
  //     });
  //   }
  // }
  for await (const prod of cursor) {
    checked++;
    const { outOfStock: shouldBeOOS, removedCount } = cleanAndComputeOOS(prod, started,days);

    if (removedCount > 0 || shouldBeOOS !== prod.out_of_stock) {
      const updateDoc = {
        available_dealers: prod.available_dealers,
        updated_at: new Date(),
      };

      if (shouldBeOOS !== prod.out_of_stock) {
        updateDoc.out_of_stock = shouldBeOOS;
      }

      await Product.updateOne(
        { _id: prod._id },
        {
          $set: updateDoc,
          $inc: { iteration_number: 1 }
        }
      );

      updated++;

      const changedFields = [];
      const changedValue = [];

      if (removedCount > 0) {
        changedFields.push("available_dealers");
        changedValue.push({
          field: "available_dealers",
          old_value: `[${removedCount} dealer removed due to stale stock]`,
          new_value: prod.available_dealers,
        });
      }

      if (shouldBeOOS !== prod.out_of_stock) {
        changedFields.push("out_of_stock");
        changedValue.push({
          field: "out_of_stock",
          old_value: prod.out_of_stock,
          new_value: shouldBeOOS,
        });
      }

      logs.push({
        job_type: "Stock-Sweep",
        product_ref: prod._id,
        user: "SYSTEM",
        changed_fields: changedFields,
        changed_value: changedValue,
      });
    }

  }

  // bulk-insert logs (if any)
  // if (logs.length) await ProductLog.insertMany(logs);

  logger.info(
    `✅ sweep done – checked:${checked}  updated:${updated}  ${Date.now() - started
    } ms`
  );
}

/* ─────────────────────────── start-up ───────────────────────────── */
async function startSweeper() {
  await mongoose.connect(MONGO_URI);
  logger.info("🛢️  Mongo connected – stock-sweeper online");

  // run once on boot
  sweep().catch((e) => logger.error("sweep-error:", e));

  // “0 */1 * * * *” = every minute; change to 15 or 30 min in prod
  // cron.schedule("0 */15 * * * *", () => sweep().catch(logger.error));
  //every 5 minutes
  cron.schedule("0 */5 * * * *", () => sweep().catch(logger.error));

}

/* If this file is run directly: `node jobs/stockSweeper.js` */
if (require.main === module) {
  startSweeper().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { sweep };
