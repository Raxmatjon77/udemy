'use client';

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@udemy/ui/components/tabs';

import { MyLearning } from '@/components/commerce/my-learning';

import { MyCertificates } from './my-certificates';
import { MyWishlist } from './my-wishlist';

/** `/my-learning` tabs (design §10): courses with progress, the wishlist, certificates. */
export function MyLearningTabs() {
  return (
    <Tabs defaultValue="courses">
      <TabsList aria-label="My learning">
        <TabsTrigger value="courses">All courses</TabsTrigger>
        <TabsTrigger value="wishlist">Wishlist</TabsTrigger>
        <TabsTrigger value="certificates">Certificates</TabsTrigger>
      </TabsList>
      <TabsContent value="courses">
        <MyLearning />
      </TabsContent>
      <TabsContent value="wishlist">
        <MyWishlist />
      </TabsContent>
      <TabsContent value="certificates">
        <MyCertificates />
      </TabsContent>
    </Tabs>
  );
}
