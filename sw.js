// Service Worker for Pa Gerry's POS System
const CACHE_NAME = 'pagerrys-pos-v1';
const urlsToCache = [
    '/',
    '/index.html',
    'https://www.gstatic.com/firebasejs/9.15.0/firebase-app-compat.js',
    'https://www.gstatic.com/firebasejs/9.15.0/firebase-auth-compat.js',
    'https://www.gstatic.com/firebasejs/9.15.0/firebase-firestore-compat.js',
    'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css',
    'https://fonts.googleapis.com/css2?family=Segoe+UI:wght@400;500;600;700&display=swap'
];

// Install Service Worker
self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => {
                console.log('Opened cache');
                return cache.addAll(urlsToCache);
            })
            .then(() => {
                console.log('All required resources have been cached');
                return self.skipWaiting();
            })
    );
});

// Activate Service Worker
self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(cacheNames => {
            return Promise.all(
                cacheNames.map(cacheName => {
                    if (cacheName !== CACHE_NAME) {
                        console.log('Deleting old cache:', cacheName);
                        return caches.delete(cacheName);
                    }
                })
            );
        }).then(() => {
            console.log('Service Worker activated');
            return self.clients.claim();
        })
    );
});

// Fetch Event - Network First Strategy for API calls, Cache First for static assets
self.addEventListener('fetch', event => {
    const request = event.request;
    const url = new URL(request.url);

    // Handle Firebase API calls (Network First)
    if (url.hostname.includes('firebaseio.com') || 
        url.hostname.includes('googleapis.com') || 
        url.hostname.includes('firestore.googleapis.com')) {
        
        event.respondWith(
            fetch(request)
                .then(response => {
                    // If network request is successful, cache the response
                    if (response.status === 200) {
                        const responseClone = response.clone();
                        caches.open(CACHE_NAME).then(cache => {
                            cache.put(request, responseClone);
                        });
                    }
                    return response;
                })
                .catch(() => {
                    // If network fails, try to get from cache
                    return caches.match(request)
                        .then(cachedResponse => {
                            if (cachedResponse) {
                                return cachedResponse;
                            }
                            // Return a custom offline response for Firebase calls
                            return new Response(
                                JSON.stringify({ 
                                    error: 'Offline - Request failed',
                                    offline: true 
                                }),
                                {
                                    status: 503,
                                    statusText: 'Service Unavailable',
                                    headers: { 'Content-Type': 'application/json' }
                                }
                            );
                        });
                })
        );
        return;
    }

    // Handle static assets (Cache First)
    event.respondWith(
        caches.match(request)
            .then(response => {
                // Return cached version if available
                if (response) {
                    return response;
                }

                // Otherwise, fetch from network
                return fetch(request).then(response => {
                    // Check if valid response
                    if (!response || response.status !== 200 || response.type !== 'basic') {
                        return response;
                    }

                    // Clone the response since it can only be consumed once
                    const responseToCache = response.clone();

                    // Add to cache
                    caches.open(CACHE_NAME)
                        .then(cache => {
                            cache.put(request, responseToCache);
                        });

                    return response;
                });
            })
    );
});

// Background Sync for offline actions
self.addEventListener('sync', event => {
    if (event.tag === 'background-sync-sales') {
        event.waitUntil(syncOfflineSales());
    }
    if (event.tag === 'background-sync-inventory') {
        event.waitUntil(syncOfflineInventory());
    }
});

// Push Notifications
self.addEventListener('push', event => {
    const options = {
        body: event.data ? event.data.text() : 'New notification from Pa Gerry\'s POS',
        icon: '/favicon.ico',
        badge: '/favicon.ico',
        vibrate: [100, 50, 100],
        data: {
            dateOfArrival: Date.now(),
            primaryKey: 1
        },
        actions: [
            {
                action: 'explore',
                title: 'View Details',
                icon: '/images/checkmark.png'
            },
            {
                action: 'close',
                title: 'Close',
                icon: '/images/xmark.png'
            }
        ]
    };

    event.waitUntil(
        self.registration.showNotification('Pa Gerry\'s POS', options)
    );
});

// Handle notification clicks
self.addEventListener('notificationclick', event => {
    event.notification.close();

    if (event.action === 'explore') {
        // Open the app to relevant page
        event.waitUntil(
            clients.openWindow('/')
        );
    }
});

// Sync offline sales data
function syncOfflineSales() {
    return new Promise((resolve, reject) => {
        // Get all offline sales from IndexedDB
        getOfflineData('sales')
            .then(sales => {
                if (sales.length === 0) {
                    resolve('No sales to sync');
                    return;
                }

                // Sync each sale to Firebase
                const syncPromises = sales.map(sale => {
                    return fetch('https://firestore.googleapis.com/v1/projects/pagerrysgrillsales/databases/(default)/documents/sales', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify({
                            fields: {
                                userId: { stringValue: sale.userId },
                                section: { stringValue: sale.section },
                                items: { arrayValue: { values: sale.items.map(item => ({ mapValue: { fields: item } })) } },
                                total: { doubleValue: sale.total },
                                paymentMethod: { stringValue: sale.paymentMethod },
                                customerName: { stringValue: sale.customerName || '' },
                                customerPhone: { stringValue: sale.customerPhone || '' },
                                timestamp: { timestampValue: sale.timestamp },
                                synced: { booleanValue: false }
                            }
                        })
                    })
                    .then(response => {
                        if (response.ok) {
                            // Mark as synced in IndexedDB
                            markAsSynced('sales', sale.id);
                            return response.json();
                        }
                        throw new Error('Failed to sync sale');
                    });
                });

                return Promise.all(syncPromises);
            })
            .then(() => resolve('Sales synced successfully'))
            .catch(error => reject(error));
    });
}

// Sync offline inventory changes
function syncOfflineInventory() {
    return new Promise((resolve, reject) => {
        // Get all offline inventory changes from IndexedDB
        getOfflineData('inventory')
            .then(changes => {
                if (changes.length === 0) {
                    resolve('No inventory changes to sync');
                    return;
                }

                // Sync each change to Firebase
                const syncPromises = changes.map(change => {
                    const method = change.type === 'delete' ? 'DELETE' : 'PATCH';
                    const url = change.type === 'delete' 
                        ? `https://firestore.googleapis.com/v1/projects/pagerrysgrillsales/databases/(default)/documents/inventory/${change.id}`
                        : `https://firestore.googleapis.com/v1/projects/pagerrysgrillsales/databases/(default)/documents/inventory/${change.id}`;

                    return fetch(url, {
                        method: method,
                        headers: {
                            'Content-Type': 'application/json',
                        },
                        body: change.type !== 'delete' ? JSON.stringify({
                            fields: {
                                name: { stringValue: change.name },
                                price: { doubleValue: change.price },
                                stock: { integerValue: change.stock },
                                section: { stringValue: change.section },
                                status: { stringValue: change.status },
                                description: { stringValue: change.description || '' },
                                updatedAt: { timestampValue: new Date().toISOString() }
                            }
                        }) : undefined
                    })
                    .then(response => {
                        if (response.ok) {
                            // Mark as synced in IndexedDB
                            markAsSynced('inventory', change.id);
                            return response.json();
                        }
                        throw new Error('Failed to sync inventory change');
                    });
                });

                return Promise.all(syncPromises);
            })
            .then(() => resolve('Inventory changes synced successfully'))
            .catch(error => reject(error));
    });
}

// IndexedDB helper functions
function openIndexedDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open('PagerrysPOS', 1);
        
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
        
        request.onupgradeneeded = event => {
            const db = event.target.result;
            
            // Create object stores for offline data
            if (!db.objectStoreNames.contains('sales')) {
                const salesStore = db.createObjectStore('sales', { keyPath: 'id' });
                salesStore.createIndex('timestamp', 'timestamp', { unique: false });
                salesStore.createIndex('synced', 'synced', { unique: false });
            }
            
            if (!db.objectStoreNames.contains('inventory')) {
                const inventoryStore = db.createObjectStore('inventory', { keyPath: 'id' });
                inventoryStore.createIndex('section', 'section', { unique: false });
                inventoryStore.createIndex('synced', 'synced', { unique: false });
            }
            
            if (!db.objectStoreNames.contains('settings')) {
                db.createObjectStore('settings', { keyPath: 'key' });
            }
        };
    });
}

// Get offline data from IndexedDB
function getOfflineData(storeName) {
    return new Promise((resolve, reject) => {
        openIndexedDB()
            .then(db => {
                const transaction = db.transaction([storeName], 'readonly');
                const store = transaction.objectStore(storeName);
                const request = store.getAll();
                
                request.onsuccess = () => resolve(request.result.filter(item => !item.synced));
                request.onerror = () => reject(request.error);
            })
            .catch(reject);
    });
}

// Mark item as synced in IndexedDB
function markAsSynced(storeName, id) {
    return new Promise((resolve, reject) => {
        openIndexedDB()
            .then(db => {
                const transaction = db.transaction([storeName], 'readwrite');
                const store = transaction.objectStore(storeName);
                const request = store.get(id);
                
                request.onsuccess = () => {
                    const item = request.result;
                    if (item) {
                        item.synced = true;
                        const updateRequest = store.put(item);
                        updateRequest.onsuccess = () => resolve();
                        updateRequest.onerror = () => reject(updateRequest.error);
                    } else {
                        resolve();
                    }
                };
                request.onerror = () => reject(request.error);
            })
            .catch(reject);
    });
}

// Save offline data to IndexedDB
function saveOfflineData(storeName, data) {
    return new Promise((resolve, reject) => {
        openIndexedDB()
            .then(db => {
                const transaction = db.transaction([storeName], 'readwrite');
                const store = transaction.objectStore(storeName);
                const request = store.put(data);
                
                request.onsuccess = () => resolve();
                request.onerror = () => reject(request.error);
            })
            .catch(reject);
    });
}

// Periodic sync check
self.addEventListener('periodicsync', event => {
    if (event.tag === 'periodic-sync') {
        event.waitUntil(
            Promise.all([
                syncOfflineSales(),
                syncOfflineInventory()
            ])
        );
    }
});