import { createBrowserRouter } from 'react-router'
import { BatchesScreen } from './screens/Batches'
import { BatchEntry } from './screens/BatchEntry'
import { GridScreen } from './screens/Grid'
import { ProductScreen } from './screens/Product'
import { QueueScreen } from './screens/Queue'
import { UploadScreen } from './screens/Upload'

export const router = createBrowserRouter([
  { path: '/', element: <BatchesScreen /> },
  { path: '/batches/:batchId', element: <BatchEntry /> },
  { path: '/batches/:batchId/products/:productId', element: <ProductScreen /> },
  { path: '/batches/:batchId/grid', element: <GridScreen /> },
  { path: '/batches/:batchId/queue', element: <QueueScreen /> },
  { path: '/batches/:batchId/upload', element: <UploadScreen /> },
])
