// services/inventoryService.js

import axios from 'axios';
import xml2js from 'xml2js';
import User from '../models/Users.js';

/**
 * Get competitor prices for a specific item
 * @param {String} itemId - The eBay item ID
 * @param {String} userId - The user ID (optional)
 */
export async function getCompetitorPrice(itemId, userId = null) {
  try {
    console.log(`🔍 Getting competitor price for item ${itemId}`);

    // First, try to get manually added competitors from MongoDB
    const userId_actual =
      userId || process.env.DEFAULT_USER_ID || '68430c2b0e746fb6c6ef1a7a';

    try {
      // Get manually added competitors
      const { default: ManualCompetitor } = await import(
        '../models/ManualCompetitor.js'
      );

      const manualCompetitorDoc = await ManualCompetitor.findOne({
        userId: userId_actual,
        itemId,
      });

      if (manualCompetitorDoc && manualCompetitorDoc.competitors.length > 0) {
        // Extract prices from manual competitors - USE STORED PRICES ONLY
        const prices = manualCompetitorDoc.competitors
          .map((comp) => {
            const price = parseFloat(comp.price);
            return isNaN(price) ? null : price;
          })
          .filter((price) => price !== null && price > 0);

        if (prices.length > 0) {
          const lowestPrice = Math.min(...prices);
          console.log(
            `📊 Found ${prices.length} manual competitor prices, lowest: ${lowestPrice}`
          );

          return {
            success: true,
            price: lowestPrice.toFixed(2),
            count: prices.length,
            allPrices: prices,
            productInfo: manualCompetitorDoc.competitors,
            source: 'manual_competitors',
          };
        }
      }
    } catch (mongoError) {
      console.warn(
        'Failed to get manual competitors from MongoDB:',
        mongoError.message
      );
    }

    // If no manual competitors, return no competition
    console.log(`⚠️ No manual competitors found for ${itemId}`);

    return {
      success: false,
      price: '0.00',
      count: 0,
      allPrices: [],
      productInfo: [],
      source: 'no_competitors',
      message: 'No competitors found',
    };
  } catch (error) {
    console.error(`❌ Error getting competitor price for ${itemId}:`, error);
    return {
      success: false,
      price: '0.00',
      count: 0,
      allPrices: [],
      productInfo: [],
      error: error.message,
      source: 'error',
    };
  }
}

/**
 * Get updated price for an item if it exists - simplified version
 */
function getUpdatedPrice(itemId, sku) {
  // For now, just return null since we're updating eBay directly
  // The frontend should get the latest price from eBay API calls
  return null;
}

/**
 * Get active eBay listings using Trading API
 */
export async function getActiveListings(userId = null) {
  try {
    // Get user ID from parameter or try to find it
    const targetUserId = userId || process.env.DEFAULT_USER_ID;

    if (!targetUserId) {
      throw new Error('User ID is required for fetching eBay listings');
    }

    console.log(`🔍 Fetching active listings for user: ${targetUserId}`);

    // Get eBay access token for the user
    const tokenData = await getValidTokenForUser(targetUserId);

    if (!tokenData || !tokenData.access_token) {
      throw new Error('No eBay access token available');
    }

    // Make request to eBay API
    const response = await ebayApiRequest('/ws/api.dll', {
      method: 'POST',
      headers: {
        'X-EBAY-API-SITEID': '0',
        'X-EBAY-API-COMPATIBILITY-LEVEL': '967',
        'X-EBAY-API-CALL-NAME': 'GetMyeBaySelling',
        'X-EBAY-API-IAF-TOKEN': tokenData.access_token,
        'Content-Type': 'text/xml',
      },
      data: `<?xml version="1.0" encoding="utf-8"?>
        <GetMyeBaySellingRequest xmlns="urn:ebay:apis:eBLBaseComponents">
          <RequesterCredentials>
            <eBayAuthToken>${tokenData.access_token}</eBayAuthToken>
          </RequesterCredentials>
          <ActiveList>
            <Include>true</Include>
            <Pagination>
              <EntriesPerPage>200</EntriesPerPage>
              <PageNumber>1</PageNumber>
            </Pagination>
          </ActiveList>
          <OutputSelector>ActiveList.ItemArray.Item.ItemID</OutputSelector>
          <OutputSelector>ActiveList.ItemArray.Item.Title</OutputSelector>
          <OutputSelector>ActiveList.ItemArray.Item.BuyItNowPrice</OutputSelector>
          <OutputSelector>ActiveList.ItemArray.Item.Quantity</OutputSelector>
          <OutputSelector>ActiveList.ItemArray.Item.SKU</OutputSelector>
          <OutputSelector>ActiveList.ItemArray.Item.SellingStatus</OutputSelector>
          <OutputSelector>ActiveList.ItemArray.Item.ConditionDisplayName</OutputSelector>
        </GetMyeBaySellingRequest>`,
    });

    return {
      success: true,
      data: response,
    };
  } catch (error) {
    console.error('❌ Error in getActiveListings:', error);
    return {
      success: false,
      error: `Failed to fetch eBay listings: ${error.message}`,
    };
  }
}

/**
 * Update eBay listing price using Trading API directly
 * THIS IS ONLY CALLED BY STRATEGY SERVICE - NOT MANUAL EDITING
 */
export async function updateEbayPrice(itemId, sku, newPrice, userId = null) {
  try {
    console.log(
      `🔄 [INVENTORY] Attempting to update eBay price for ${itemId} to $${newPrice}`
    );

    // Get user with eBay credentials
    let user = null;
    if (userId) {
      user = await User.findById(userId);
    }

    if (!user || !user.ebay?.accessToken) {
      user = await User.findOne({ 'ebay.accessToken': { $exists: true } });
    }

    if (!user || !user.ebay.accessToken) {
      console.error('❌ No eBay credentials found');
      return {
        success: false,
        itemId,
        newPrice,
        message: 'No eBay credentials available',
        error: 'No eBay token',
        requiresReauth: true,
      };
    }

    // Check if token is expired
    if (user.ebay.expiresAt && new Date() >= user.ebay.expiresAt) {
      console.warn('⚠️ eBay token expired, attempting refresh...');

      if (user.ebay.refreshToken) {
        try {
          const refreshResult = await refreshEbayToken(user.ebay.refreshToken);
          if (refreshResult.access_token) {
            user.ebay.accessToken = refreshResult.access_token;
            user.ebay.expiresAt = new Date(
              Date.now() + refreshResult.expires_in * 1000
            );
            await user.save();
            console.log('✅ eBay token refreshed successfully');
          } else {
            throw new Error('No access token in refresh response');
          }
        } catch (refreshError) {
          console.error('❌ Token refresh failed:', refreshError);
          return {
            success: false,
            itemId,
            newPrice,
            message: 'eBay token expired and refresh failed',
            error: 'Token refresh failed',
            requiresReauth: true,
          };
        }
      } else {
        return {
          success: false,
          itemId,
          newPrice,
          message: 'eBay token expired - please re-authenticate',
          error: 'Token expired',
          requiresReauth: true,
        };
      }
    }

    const authToken = user.ebay.accessToken;

    // First try to get current price to verify the change
    let currentPriceBeforeUpdate = null;
    try {
      const currentPriceResult = await getCurrentEbayPrice(itemId);
      if (currentPriceResult) {
        currentPriceBeforeUpdate = currentPriceResult;
        console.log(
          `📊 Current price before update: $${currentPriceBeforeUpdate}`
        );
      }
    } catch (priceError) {
      console.warn(
        'Could not get current price before update:',
        priceError.message
      );
    }

    // First try to get item details to check if it uses SKU management
    const getItemRequest = `<?xml version="1.0" encoding="utf-8"?>
<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials>
    <eBayAuthToken>${authToken}</eBayAuthToken>
  </RequesterCredentials>
  <ItemID>${itemId}</ItemID>
  <OutputSelector>Item.InventoryTrackingMethod</OutputSelector>
  <OutputSelector>Item.SKU</OutputSelector>
</GetItemRequest>`;

    const ebayUrl =
      process.env.NODE_ENV === 'production'
        ? 'https://api.ebay.com/ws/api.dll'
        : 'https://api.sandbox.ebay.com/ws/api.dll';

    console.log(`🔍 Checking item details for ${itemId}...`);

    try {
      const getItemResponse = await axios({
        method: 'POST',
        url: ebayUrl,
        headers: {
          'Content-Type': 'text/xml',
          'X-EBAY-API-CALL-NAME': 'GetItem',
          'X-EBAY-API-SITEID': '0',
          'X-EBAY-API-COMPATIBILITY-LEVEL': '1119',
          'X-EBAY-API-APP-NAME': process.env.CLIENT_ID,
        },
        data: getItemRequest,
      });

      const parser = new xml2js.Parser({
        explicitArray: false,
        ignoreAttrs: true,
      });

      const getItemResult = await new Promise((resolve, reject) => {
        parser.parseString(getItemResponse.data, (err, result) => {
          if (err) reject(err);
          else resolve(result);
        });
      });

      const itemDetails = getItemResult.GetItemResponse;
      const inventoryMethod = itemDetails?.Item?.InventoryTrackingMethod;
      const itemSku = itemDetails?.Item?.SKU;

      console.log(`📋 Item ${itemId} details:`, {
        inventoryMethod,
        itemSku,
        usesSKU: inventoryMethod === 'SKU',
      });

      // Use ReviseFixedPriceItem for non-SKU managed items or if no valid SKU
      if (inventoryMethod !== 'SKU' || !itemSku) {
        console.log(
          `🔄 Using ReviseFixedPriceItem for ${itemId} (no SKU management)`
        );

        const reviseItemRequest = `<?xml version="1.0" encoding="utf-8"?>
<ReviseFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials>
    <eBayAuthToken>${authToken}</eBayAuthToken>
  </RequesterCredentials>
  <Item>
    <ItemID>${itemId}</ItemID>
    <StartPrice>${newPrice}</StartPrice>
  </Item>
</ReviseFixedPriceItemRequest>`;

        const reviseResponse = await axios({
          method: 'POST',
          url: ebayUrl,
          headers: {
            'Content-Type': 'text/xml',
            'X-EBAY-API-CALL-NAME': 'ReviseFixedPriceItem',
            'X-EBAY-API-SITEID': '0',
            'X-EBAY-API-COMPATIBILITY-LEVEL': '1119',
            'X-EBAY-API-APP-NAME': process.env.CLIENT_ID,
          },
          data: reviseItemRequest,
        });

        const reviseResult = await new Promise((resolve, reject) => {
          parser.parseString(reviseResponse.data, (err, result) => {
            if (err) reject(err);
            else resolve(result);
          });
        });

        const reviseResponseData = reviseResult.ReviseFixedPriceItemResponse;

        if (
          reviseResponseData.Ack === 'Success' ||
          reviseResponseData.Ack === 'Warning'
        ) {
          console.log(
            `✅ [INVENTORY] eBay price update successful for ${itemId} using ReviseFixedPriceItem`
          );

          // Verify the actual price change occurred
          let actualPriceChangeConfirmed = false;
          if (currentPriceBeforeUpdate) {
            const priceChange = Math.abs(newPrice - currentPriceBeforeUpdate);
            actualPriceChangeConfirmed = priceChange >= 0.01;
            console.log(
              `📊 Price change verification: $${currentPriceBeforeUpdate} → $${newPrice} (change: $${priceChange.toFixed(
                2
              )}, confirmed: ${actualPriceChangeConfirmed})`
            );
          }

          return {
            success: true,
            itemId,
            oldPrice: currentPriceBeforeUpdate,
            newPrice,
            priceChangeConfirmed: actualPriceChangeConfirmed,
            message:
              'Price updated successfully on eBay via ReviseFixedPriceItem',
            ebayResponse: reviseResponseData,
            timestamp: new Date(),
            method: 'ReviseFixedPriceItem',
          };
        } else {
          throw new Error(
            reviseResponseData.Errors?.LongMessage ||
              'ReviseFixedPriceItem failed'
          );
        }

        return {
          success: true,
          itemId,
          newPrice,
          message:
            'Price updated successfully on eBay via ReviseFixedPriceItem',
          ebayResponse: reviseResponseData,
          timestamp: new Date(),
          method: 'ReviseFixedPriceItem',
        };
      } else {
        // Use ReviseInventoryStatus for SKU-managed items
        console.log(
          `🔄 Using ReviseInventoryStatus for ${itemId} with SKU: ${itemSku}`
        );

        const xmlRequest = `<?xml version="1.0" encoding="utf-8"?>
<ReviseInventoryStatusRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials>
    <eBayAuthToken>${authToken}</eBayAuthToken>
  </RequesterCredentials>
  <InventoryStatus>
    <ItemID>${itemId}</ItemID>
    <SKU>${itemSku}</SKU>
    <StartPrice>${newPrice}</StartPrice>
  </InventoryStatus>
</ReviseInventoryStatusRequest>`;

        const response = await axios({
          method: 'POST',
          url: ebayUrl,
          headers: {
            'Content-Type': 'text/xml',
            'X-EBAY-API-CALL-NAME': 'ReviseInventoryStatus',
            'X-EBAY-API-SITEID': '0',
            'X-EBAY-API-COMPATIBILITY-LEVEL': '1119',
            'X-EBAY-API-APP-NAME': process.env.CLIENT_ID,
          },
          data: xmlRequest,
        });

        const result = await new Promise((resolve, reject) => {
          parser.parseString(response.data, (err, result) => {
            if (err) reject(err);
            else resolve(result);
          });
        });

        const reviseResponse = result.ReviseInventoryStatusResponse;

        if (
          reviseResponse.Ack === 'Success' ||
          reviseResponse.Ack === 'Warning'
        ) {
          console.log(
            `✅ eBay price update successful for ${itemId} using ReviseInventoryStatus`
          );

          // Don't record price history here - let the strategy service handle it
        } else {
          throw new Error(
            reviseResponse.Errors?.LongMessage || 'ReviseInventoryStatus failed'
          );
        }

        return {
          success: true,
          itemId,
          newPrice,
          message:
            'Price updated successfully on eBay via ReviseInventoryStatus',
          ebayResponse: reviseResponse,
          timestamp: new Date(),
          method: 'ReviseInventoryStatus',
        };
      }
    } catch (getItemError) {
      console.warn(
        `⚠️ Could not get item details for ${itemId}, trying ReviseFixedPriceItem as fallback:`,
        getItemError.message
      );

      // Fallback to ReviseFixedPriceItem if GetItem fails
      const reviseItemRequest = `<?xml version="1.0" encoding="utf-8"?>
<ReviseFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials>
    <eBayAuthToken>${authToken}</eBayAuthToken>
  </RequesterCredentials>
  <Item>
    <ItemID>${itemId}</ItemID>
    <StartPrice>${newPrice}</StartPrice>
  </Item>
</ReviseFixedPriceItemRequest>`;

      const reviseResponse = await axios({
        method: 'POST',
        url: ebayUrl,
        headers: {
          'Content-Type': 'text/xml',
          'X-EBAY-API-CALL-NAME': 'ReviseFixedPriceItem',
          'X-EBAY-API-SITEID': '0',
          'X-EBAY-API-COMPATIBILITY-LEVEL': '1119',
          'X-EBAY-API-APP-NAME': process.env.CLIENT_ID,
        },
        data: reviseItemRequest,
      });

      const parser = new xml2js.Parser({
        explicitArray: false,
        ignoreAttrs: true,
      });

      const reviseResult = await new Promise((resolve, reject) => {
        parser.parseString(reviseResponse.data, (err, result) => {
          if (err) reject(err);
          else resolve(result);
        });
      });

      const reviseResponseData = reviseResult.ReviseFixedPriceItemResponse;

      if (
        reviseResponseData.Ack === 'Success' ||
        reviseResponseData.Ack === 'Warning'
      ) {
        console.log(
          `✅ eBay price update successful for ${itemId} using fallback ReviseFixedPriceItem`
        );

        // Don't record price history here - let the strategy service handle it

        return {
          success: true,
          itemId,
          newPrice,
          message:
            'Price updated successfully on eBay via fallback ReviseFixedPriceItem',
          ebayResponse: reviseResponseData,
          timestamp: new Date(),
          method: 'ReviseFixedPriceItem_fallback',
        };
      } else {
        console.error(
          `❌ eBay API returned error for ${itemId}:`,
          reviseResponseData
        );

        // Check for token expiry specifically
        if (reviseResponseData.Errors?.ErrorCode === '932') {
          return {
            success: false,
            itemId,
            newPrice,
            message:
              'eBay authentication token expired - please re-authenticate',
            error: 'Invalid eBay token',
            requiresReauth: true,
          };
        }

        return {
          success: false,
          itemId,
          newPrice,
          message: 'eBay API error',
          error: reviseResponseData.Errors?.LongMessage || 'Unknown eBay error',
          ebayError: reviseResponseData.Errors,
        };
      }
    }
  } catch (error) {
    console.error(`❌ Error updating eBay price for ${itemId}:`, error);

    // Check if it's a 401 or authentication error
    if (error.response?.status === 401 || error.message.includes('token')) {
      return {
        success: false,
        itemId,
        newPrice,
        message: 'eBay authentication failed - please re-authenticate',
        error: 'Authentication failed',
        requiresReauth: true,
      };
    }

    return {
      success: false,
      error: error.message,
      itemId,
      newPrice,
      message: 'Failed to update eBay price',
    };
  }
}

/**
 * Monitor and sync price changes based on strategies
 * @param {String} itemId - The item to monitor
 * @param {String} userId - User ID for eBay credentials
 */
export async function syncPriceWithStrategy(itemId, userId = null) {
  try {
    // Import strategy service to execute pricing logic
    const { executeStrategiesForItem } = await import('./strategyService.js');

    const result = await executeStrategiesForItem(itemId);

    return result;
  } catch (error) {
    return {
      success: false,
      error: error.message,
      itemId,
    };
  }
}

/**
 * Get current price of an item from eBay
 * @param {String} itemId - The eBay item ID
 * @param {String} sku - The item SKU
 * @param {String} userId - User ID for eBay credentials
 */
export async function getCurrentEbayPrice(itemId, sku = null, userId = null) {
  try {
    const listings = await getActiveListings(userId);

    if (listings.success && listings.data.GetMyeBaySellingResponse) {
      const itemArray =
        listings.data.GetMyeBaySellingResponse.ActiveList?.ItemArray;
      let items = [];

      if (Array.isArray(itemArray?.Item)) {
        items = itemArray.Item;
      } else if (itemArray?.Item) {
        items = [itemArray.Item];
      }

      const item = items.find((i) => i.ItemID === itemId);

      if (item && item.BuyItNowPrice) {
        const currentPrice = parseFloat(item.BuyItNowPrice);
        return {
          success: true,
          price: currentPrice,
          itemId,
          sku: item.SKU || sku,
        };
      }
    }

    return {
      success: false,
      error: 'Item not found or no price available',
      itemId,
      sku,
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
      itemId,
      sku,
    };
  }
}

/**
 * Get valid eBay token for a user
 * @param {String} userId - The user ID
 */
async function getValidTokenForUser(userId) {
  try {
    const user = await User.findById(userId);

    if (!user || !user.ebay || !user.ebay.accessToken) {
      throw new Error('No eBay access token found for user');
    }

    // Check if token is expired
    if (user.ebay.expiresAt && new Date() >= user.ebay.expiresAt) {
      // Try to refresh the token
      if (user.ebay.refreshToken) {
        try {
          const refreshResult = await refreshEbayToken(user.ebay.refreshToken);
          if (refreshResult.access_token) {
            // Update user with new token
            user.ebay.accessToken = refreshResult.access_token;
            user.ebay.expiresAt = new Date(
              Date.now() + refreshResult.expires_in * 1000
            );
            await user.save();

            return {
              access_token: refreshResult.access_token,
              expires_in: refreshResult.expires_in,
            };
          }
        } catch (refreshError) {
          console.error('Failed to refresh eBay token:', refreshError);
          throw new Error('eBay token expired and refresh failed');
        }
      }
      throw new Error('eBay token expired');
    }

    return {
      access_token: user.ebay.accessToken,
      expires_in: user.ebay.expiresAt
        ? Math.floor((user.ebay.expiresAt - new Date()) / 1000)
        : 7200,
    };
  } catch (error) {
    console.error('Error getting valid token for user:', error);
    throw error;
  }
}

/**
 * Refresh eBay token using refresh token
 * @param {String} refreshToken
 */
async function refreshEbayToken(refreshToken) {
  try {
    const response = await axios.post(
      'https://api.ebay.com/identity/v1/oauth2/token',
      `grant_type=refresh_token&refresh_token=${refreshToken}`,
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${Buffer.from(
            `${process.env.CLIENT_ID}:${process.env.CLIENT_SECRET}`
          ).toString('base64')}`,
        },
      }
    );

    return response.data;
  } catch (error) {
    console.error('Error refreshing eBay token:', error);
    throw error;
  }
}

/**
 * Make eBay API request with proper error handling
 * @param {String} endpoint
 * @param {Object} options
 */
// async function ebayApiRequest(endpoint, options) {
//   try {
//     const ebayUrl =
//       process.env.NODE_ENV === 'production'
//         ? `https://api.ebay.com${endpoint}`
//         : `https://api.sandbox.ebay.com${endpoint}`;

//     const response = await axios({
//       url: ebayUrl,
//       ...options,
//     });

//     // Parse XML response
//     const parser = new xml2js.Parser({
//       explicitArray: false,
//       ignoreAttrs: true,
//     });

//     return new Promise((resolve, reject) => {
//       parser.parseString(response.data, (err, result) => {
//         if (err) {
//           reject(err);
//         } else {
//           resolve(result);
//         }
//       });
//     });
//   } catch (error) {
//     console.error('eBay API request failed:', error);
//     throw error;
//   }
// }
/**
 * Make eBay API request with proper error handling
 * @param {String} endpoint
 * @param {Object} options
 */
async function ebayApiRequest(endpoint, options) {
  try {
    const ebayUrl =
      process.env.NODE_ENV === 'production'
        ? `https://api.ebay.com${endpoint}`
        : `https://api.sandbox.ebay.com${endpoint}`;

    const response = await axios({
      url: ebayUrl,
      ...options,
    });

    // Parse XML response
    const parser = new xml2js.Parser({
      explicitArray: false,
      ignoreAttrs: true,
    });

    return new Promise((resolve, reject) => {
      parser.parseString(response.data, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });
  } catch (error) {
    console.error('eBay API request failed:', error);
    throw error;
  }
}
