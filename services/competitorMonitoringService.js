import cron from 'node-cron';

/**
 * Service to automatically monitor competitor prices and execute strategies
 */

/**
 * Update competitor prices and trigger strategies when prices change
 */
export async function updateCompetitorPrices() {
  try {

    const { default: ManualCompetitor } = await import(
      '../models/ManualCompetitor.js'
    );
    const { default: User } = await import('../models/Users.js');

    // Get all manual competitors with monitoring enabled
    const allCompetitorDocs = await ManualCompetitor.find({
      monitoringEnabled: true,
    }).populate('userId');

    let totalUpdated = 0;
    let totalChecked = 0;
    let strategiesTriggered = 0;

    for (const doc of allCompetitorDocs) {
      try {
        // Get user's eBay credentials
        const user = await User.findById(doc.userId);
        if (!user?.ebay?.accessToken) {
          console.warn(`⚠️ No eBay credentials for user ${doc.userId}`);
          continue;
        }

        // Only execute strategies based on existing competitor data

        const strategyResult = await triggerStrategyForItem(
          doc.itemId,
          doc.userId
        );

        if (strategyResult.success) {
          strategiesTriggered++;
        }

        // Update last monitoring check
        doc.lastMonitoringCheck = new Date();
        await doc.save();

        // Add delay to avoid rate limiting
        await new Promise((resolve) => setTimeout(resolve, 1000));
      } catch (itemError) {
        console.error(`Error processing item ${doc.itemId}:`, itemError);
      }
    }

    return { totalChecked, totalUpdated, strategiesTriggered };
  } catch (error) {
    console.error('❌ Error in updateCompetitorPrices:', error);
    throw error;
  }
}

/**
 * Trigger strategy execution for a specific item
 */
export async function triggerStrategyForItem(itemId, userId) {
  try {

    const { executeStrategiesForItem } = await import('./strategyService.js');
    const result = await executeStrategiesForItem(itemId, userId);

    return result;
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Execute strategies for all items with competitors
 */
export async function executeStrategiesForAllItems() {
  try {
    const { default: ManualCompetitor } = await import(
      '../models/ManualCompetitor.js'
    );

    const allItems = await ManualCompetitor.find({
      'competitors.0': { $exists: true },
    });

    let strategiesExecuted = 0;
    let priceChanges = 0;

    for (const item of allItems) {
      try {
        const result = await triggerStrategyForItem(item.itemId, item.userId);

        if (result.success) {
          strategiesExecuted++;
          if (result.priceChanges > 0) {
            priceChanges += result.priceChanges;
          }
        }

        await new Promise((resolve) => setTimeout(resolve, 500));
      } catch (error) {
        console.error(`❌ Error executing strategy for ${item.itemId}:`, error);
      }
    }

    return {
      success: true,
      strategiesExecuted,
      priceChanges,
      totalItems: allItems.length,
    };
  } catch (error) {
    console.error('❌ Error in executeStrategiesForAllItems:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Start the automated monitoring system
 */
export function startCompetitorMonitoring() {

  // Run every 20 minutes
  cron.schedule('*/20 * * * *', async () => {
    try {
      await updateCompetitorPrices();
    } catch (error) {
      console.error('❌ Error in scheduled competitor monitoring:', error);
    }
  });

}

/**
 * Manual trigger for immediate strategy execution
 */
// export async function manualCompetitorUpdate(itemId = null) {
//   try {
//     if (itemId) {
//       const { default: ManualCompetitor } = await import(
//         '../models/ManualCompetitor.js'
//       );
//       const doc = await ManualCompetitor.findOne({ itemId });

//       if (doc) {
//         const result = await triggerStrategyForItem(itemId, doc.userId);
//         return { success: true, result };
//       } else {
//         return { success: false, error: 'Item not found' };
//       }
//     } else {
//       const result = await executeStrategiesForAllItems();
//       return { success: true, result };
//     }
//   } catch (error) {
//     return { success: false, error: error.message };
//   }
// }

/**
 * Execute strategies for all items with competitors (page load trigger)
 * IMPORTANT: This should NOT change competitor prices, only execute strategies
 */
// export async function executeStrategiesForAllItems() {
//   try {
//     console.log('🚀 Executing strategies for all items with competitors...');

//     const { default: ManualCompetitor } = await import(
//       '../models/ManualCompetitor.js'
//     );

//     const allItems = await ManualCompetitor.find({
//       'competitors.0': { $exists: true },
//     });

//     let strategiesExecuted = 0;
//     let priceChanges = 0;

//     // FIXED: Add rate limiting to prevent version conflicts
//     const BATCH_SIZE = 3; // Process 3 items at a time
//     const DELAY_BETWEEN_BATCHES = 2000; // 2 second delay between batches

//     for (let i = 0; i < allItems.length; i += BATCH_SIZE) {
//       const batch = allItems.slice(i, i + BATCH_SIZE);

//       console.log(
//         `📦 Processing batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(
//           allItems.length / BATCH_SIZE
//         )} (${batch.length} items)`
//       );

//       // Process batch in parallel but limit concurrency
//       const batchPromises = batch.map(async (item, index) => {
//         try {
//           // Add staggered delay within batch to reduce conflicts
//           await new Promise((resolve) => setTimeout(resolve, index * 500));

//           console.log(`🔄 Executing strategy for ${item.itemId}...`);

//           const result = await triggerStrategyForItem(item.itemId, item.userId);

//           if (result.success) {
//             strategiesExecuted++;
//             if (result.priceChanges > 0) {
//               priceChanges += result.priceChanges;
//               console.log(`💰 Price updated for ${item.itemId}`);
//             }
//           }

//           return { success: true, itemId: item.itemId };
//         } catch (error) {
//           console.error(
//             `❌ Error executing strategy for ${item.itemId}:`,
//             error
//           );
//           return { success: false, itemId: item.itemId, error: error.message };
//         }
//       });

//       await Promise.all(batchPromises);

//       // Wait between batches to prevent overwhelming the system
//       if (i + BATCH_SIZE < allItems.length) {
//         console.log(
//           `⏳ Waiting ${DELAY_BETWEEN_BATCHES}ms before next batch...`
//         );
//         await new Promise((resolve) =>
//           setTimeout(resolve, DELAY_BETWEEN_BATCHES)
//         );
//       }
//     }

//     console.log(
//       `✅ Strategy execution completed: ${strategiesExecuted} strategies executed, ${priceChanges} price changes`
//     );

//     return {
//       success: true,
//       strategiesExecuted,
//       priceChanges,
//       totalItems: allItems.length,
//     };
//   } catch (error) {
//     console.error('❌ Error in executeStrategiesForAllItems:', error);
//     return { success: false, error: error.message };
//   }
// }

/**
 * Start the automated monitoring system
 */
// export function startCompetitorMonitoring() {
//   console.log('🚀 Starting real competitor monitoring service...');

//   // Run every 60 minutes to check for REAL competitor price changes
//   cron.schedule('0 */1 * * *', async () => {
//     try {
//       console.log('⏰ Running scheduled REAL competitor price check...');
//       await updateCompetitorPrices();
//     } catch (error) {
//       console.error('❌ Error in scheduled competitor monitoring:', error);
//     }
//   });

//   console.log(
//     '✅ Real competitor monitoring service started - checking every 60 minutes'
//   );
// }

/**
 * Manual trigger for immediate competitor check and strategy execution
 */
export async function manualCompetitorUpdate(itemId = null) {
  try {
    if (itemId) {
      // Update specific item
      const { default: ManualCompetitor } = await import(
        '../models/ManualCompetitor.js'
      );
      const doc = await ManualCompetitor.findOne({ itemId });

      if (doc) {
        const result = await triggerStrategyForItem(itemId, doc.userId);
        return { success: true, result };
      } else {
        return { success: false, error: 'Item not found' };
      }
    } else {
      // Update all items with REAL price checking
      const result = await updateCompetitorPrices();
      return { success: true, result };
    }
  } catch (error) {
    return { success: false, error: error.message };
  }
}
